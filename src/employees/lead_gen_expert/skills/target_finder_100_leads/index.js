import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runContactFinder } from '../contact_finder/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 70;
const TARGET_HIGH_SCORE_COUNT = 100;
const MAX_ITERATIONS = 200;

async function callClaude(params, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await getAnthropic().messages.create(params);
    } catch (err) {
      if (err?.status === 429 && attempt < retries - 1) {
        const wait = 60000;
        console.log(`[target_finder] Rate limited, waiting ${wait / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

export async function executeSkill({ user_details_id, itp_id }) {
  const { data: userDetails } = await getSupabaseAdmin()
    .from('user_details')
    .select('account_id')
    .eq('id', user_details_id)
    .single();

  // Use specific ITP if provided, otherwise fall back to most recent
  let itpQuery = getSupabaseAdmin().from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();

  if (!itp) throw new Error('No ITP found for account');

  const { data: account } = await getSupabaseAdmin()
    .from('account')
    .select('organisation_name, organisation_website, description, problem_solved')
    .eq('id', itp.account_id)
    .single();

  // Load prompt templates once
  const searchPromptTemplate = await readFile(join(__dirname, 'prompt_generate_google_search.md'), 'utf-8');
  const scorePromptTemplate = await readFile(join(__dirname, 'prompt_generate_company_score.md'), 'utf-8');

  const accountPlaceholders = {
    '{{account_organisation_name}}': account?.organisation_name ?? '',
    '{{account_organisation_website}}': account?.organisation_website ?? '',
    '{{account_organisation_description}}': account?.description ?? '',
    '{{account_organisation_problem_solved}}': account?.problem_solved ?? '',
    '{{itp_summary}}': itp.itp_summary ?? '',
    '{{itp_demographic}}': itp.itp_demographic ?? '',
    '{{itp_pain_points}}': itp.itp_pain_points ?? '',
    '{{itp_buying_trigger}}': itp.itp_buying_trigger ?? '',
  };

  function fillTemplate(template, extra = {}) {
    return Object.entries({ ...accountPlaceholders, ...extra }).reduce(
      (str, [key, val]) => str.replace(key, val),
      template
    );
  }

  // Fetch existing customer websites once
  const { data: existingCustomers } = await getSupabaseAdmin()
    .from('customers')
    .select('organisation_website')
    .eq('account_id', userDetails.account_id);

  const existingWebsites = new Set(
    (existingCustomers ?? []).map(c => c.organisation_website?.toLowerCase()).filter(Boolean)
  );

  const scorePromptBase = fillTemplate(scorePromptTemplate);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Fetch all current leads for this ITP
    const { data: currentLeads } = await getSupabaseAdmin()
      .from('leads')
      .select('id, title, link, score, score_reason, approved, target_finder_google_search_prompts')
      .eq('itp', itp.id);

    const approvedCount = (currentLeads ?? []).filter(l => l.approved).length;
    console.log(`[target_finder] Iteration ${iteration + 1}: ${approvedCount}/${TARGET_HIGH_SCORE_COUNT} approved leads`);

    if (approvedCount >= TARGET_HIGH_SCORE_COUNT) {
      console.log('[target_finder] Target reached, stopping.');
      const { data: ud } = await getSupabaseAdmin()
        .from('user_details').select('queued_mobilisations').eq('id', user_details_id).single();
      const queue = ud?.queued_mobilisations ?? [];
      if (!queue.some(q => q.mobilisation === '100_approved_leads_found')) {
        await getSupabaseAdmin()
          .from('user_details')
          .update({ queued_mobilisations: [...queue, { mobilisation: '100_approved_leads_found', queued_at: new Date().toISOString() }] })
          .eq('id', user_details_id);
        console.log('[target_finder_100] Queued 100_approved_leads_found for user', user_details_id);
      }
      break;
    }

    // Build previous leads string for the search prompt
    let previousLeadsText = 'None yet.';
    if (currentLeads && currentLeads.length > 0) {
      // Collect unique search prompt IDs to fetch query text
      const promptIds = [...new Set(
        currentLeads.flatMap(l => (l.target_finder_google_search_prompts ?? []).map(p => p.id)).filter(Boolean)
      )];
      const { data: searchPrompts } = await getSupabaseAdmin()
        .from('target_finder_google_search_prompts')
        .select('id, query')
        .in('id', promptIds);

      const queryById = new Map((searchPrompts ?? []).map(p => [p.id, p.query]));

      previousLeadsText = currentLeads.map(l => {
        const firstPromptId = l.target_finder_google_search_prompts?.[0]?.id;
        const query = firstPromptId ? (queryById.get(firstPromptId) ?? 'unknown') : 'unknown';
        return `- Title: ${l.title ?? 'N/A'} | Website: ${l.link ?? 'N/A'} | Query: "${query}" | Score: ${l.score ?? 'N/A'} | Reason: ${l.score_reason ?? 'N/A'}`;
      }).join('\n');
    }

    // Generate search query
    const searchPrompt = fillTemplate(searchPromptTemplate, { '{{previous_leads}}': previousLeadsText });
    const searchResponse = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const query = searchResponse.content[0].text.trim();
    console.log('[target_finder] Query:', query);

    // Save query to DB
    const { data: insertedPrompt } = await getSupabaseAdmin()
      .from('target_finder_google_search_prompts')
      .insert({ itp: itp.id, query })
      .select('id')
      .single();

    const searchPromptId = insertedPrompt?.id;

    // Call Serper
    const serperResponse = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: 10,
        ...(itp.location ? { location: itp.location } : {}),
        hl: 'en',
      }),
    });

    const serperData = await serperResponse.json();
    console.log('[target_finder] Serper status:', serperResponse.status, '| organic:', serperData.organic?.length ?? 0);
    if (!serperResponse.ok) {
      console.error('[target_finder] Serper error:', JSON.stringify(serperData));
      break;
    }

    const organic = serperData.organic ?? [];

    // Re-fetch existing leads (updated each iteration)
    const { data: existingLeads } = await getSupabaseAdmin()
      .from('leads')
      .select('id, link, target_finder_google_search_prompts')
      .eq('itp', itp.id);

    const existingLeadsByLink = new Map(
      (existingLeads ?? []).map(l => [l.link?.toLowerCase(), l])
    );

    // Separate into new vs already-seen
    const newLeads = [];
    for (const result of organic) {
      if (!result.link) continue;
      const lowerLink = result.link.toLowerCase();

      if (existingWebsites.has(lowerLink)) continue;

      if (existingLeadsByLink.has(lowerLink)) {
        const existing = existingLeadsByLink.get(lowerLink);
        const updatedPrompts = [
          ...(existing.target_finder_google_search_prompts ?? []),
          { id: searchPromptId, position: result.position },
        ];
        await getSupabaseAdmin()
          .from('leads')
          .update({ target_finder_google_search_prompts: updatedPrompts })
          .eq('id', existing.id);
      } else {
        newLeads.push(result);
      }
    }

    console.log('[target_finder] New leads to score:', newLeads.length);

    if (newLeads.length > 0) {
      // Build a numbered list of all leads for Claude to score in one call
      const leadsList = newLeads.map((r, i) =>
        `[${i}] Title: ${r.title ?? 'N/A'}\nURL: ${r.link}\nSnippet: ${r.snippet ?? ''}`
      ).join('\n\n');

      const scorePrompt = scorePromptBase.replace('{{response_from_serper}}', leadsList);

      const scoreResponse = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: scorePrompt }],
      });

      let scores = [];
      try {
        const raw = scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        console.log('[target_finder] Score response:', raw);
        scores = JSON.parse(raw);
      } catch (e) {
        console.error('[target_finder] Failed to parse scores JSON:', scoreResponse.content[0].text);
      }

      for (const item of scores) {
        const result = newLeads[item.index];
        if (!result) continue;
        console.log('[target_finder] Scored lead:', result.link, '→', item.score, item.reason);

        const { data: insertedLead, error: insertError } = await getSupabaseAdmin().from('leads').insert({
          itp: itp.id,
          title: result.title ?? null,
          link: result.link ?? null,
          snippet: result.snippet ?? null,
          score: item.score ?? null,
          score_reason: item.reason ?? null,
          approved: (item.score ?? 0) >= HIGH_SCORE_THRESHOLD ? true : null,
          target_finder_google_search_prompts: [{ id: searchPromptId, position: result.position }],
        }).select('id').single();
        if (insertError) {
          console.error('[target_finder] Insert error for', result.link, ':', insertError);
        } else if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD && insertedLead?.id) {
          console.log('[target_finder] Auto-approved lead, dispatching contact_finder for', result.link);
          runContactFinder({ user_details_id, lead_id: insertedLead.id })
            .catch(err => console.error('[target_finder] contact_finder error:', err.message));
        }
      }
    }
  }

  // Final count
  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, title, link, score, score_reason')
    .eq('itp', itp.id);

  return { user_details_id, itp_id: itp.id, leads: finalLeads ?? [] };
}
