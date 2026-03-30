import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 70;
const TARGET_HIGH_SCORE_COUNT = 10;
const MAX_ITERATIONS = 20;

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

  // Count existing high-score leads so we find the NEXT 10, not assume starting from 0
  const { data: existingLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, rejected')
    .eq('itp_id', itp.id);
  const initialHighScoreCount = (existingLeads ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
  const dynamicTarget = initialHighScoreCount + TARGET_HIGH_SCORE_COUNT;
  console.log(`[target_finder] Starting with ${initialHighScoreCount} existing high-score leads, aiming for ${dynamicTarget}`);

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
      .select('id, target_id, score, score_reason, rejected, search_query_ids, targets(id, domain, title, link)')
      .eq('itp_id', itp.id);

    const highScoreCount = (currentLeads ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
    console.log(`[target_finder] Iteration ${iteration + 1}: ${highScoreCount}/${dynamicTarget} high-score leads`);

    if (highScoreCount >= dynamicTarget) {
      console.log('[target_finder] Target reached, stopping.');
      break;
    }

    // Build previous targets and queries for the search prompt
    let previousTargetsText = 'None yet.';
    let previousQueriesText = 'None yet.';

    // Fetch all previous queries for this ITP
    const { data: allPreviousQueries } = await getSupabaseAdmin()
      .from('target_finder_google_search_prompts')
      .select('query')
      .eq('itp', itp.id)
      .order('created_at', { ascending: true });

    if (allPreviousQueries && allPreviousQueries.length > 0) {
      previousQueriesText = allPreviousQueries.map((q, i) => `${i + 1}. ${q.query}`).join('\n');
    }

    if (currentLeads && currentLeads.length > 0) {
      previousTargetsText = currentLeads.map(l => {
        const target = l.targets;
        return `- Title: ${target?.title ?? 'N/A'} | Website: ${target?.link ?? 'N/A'} | Score: ${l.score ?? 'N/A'} | Reason: ${l.score_reason ?? 'N/A'}`;
      }).join('\n');
    }

    // Generate search query
    const searchPrompt = fillTemplate(searchPromptTemplate, {
      '{{previous_targets}}': previousTargetsText,
      '{{previous_queries}}': previousQueriesText,
    });
    const searchResponse = await callClaude({
      model: 'claude-haiku-4-5-20251001',
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

    // Separate into new vs already-seen by domain
    const newResults = [];
    for (const result of organic) {
      if (!result.link) continue;

      // Extract domain
      let domain;
      try {
        domain = new URL(result.link).hostname.replace(/^www\./, '');
      } catch { continue; }

      // Skip existing customers
      if (existingWebsites.has(result.link.toLowerCase())) continue;

      // Check if target already exists by domain
      const { data: existingTarget } = await getSupabaseAdmin()
        .from('targets').select('id').eq('domain', domain).maybeSingle();

      if (existingTarget) {
        // Target exists — check if lead already exists for this target+ITP
        const { data: existingLead } = await getSupabaseAdmin()
          .from('leads').select('id, search_query_ids').eq('target_id', existingTarget.id).eq('itp_id', itp.id).maybeSingle();

        if (existingLead) {
          // Update search_query_ids on existing lead
          const updatedQueryIds = [
            ...(existingLead.search_query_ids ?? []),
            { id: searchPromptId, position: result.position },
          ];
          await getSupabaseAdmin()
            .from('leads')
            .update({ search_query_ids: updatedQueryIds })
            .eq('id', existingLead.id);
        } else {
          // Will be scored with new results below
          newResults.push({ ...result, _domain: domain, _existingTargetId: existingTarget.id });
        }
      } else {
        newResults.push({ ...result, _domain: domain, _existingTargetId: null });
      }
    }

    console.log('[target_finder] New results to score:', newResults.length);

    if (newResults.length > 0) {
      // Build a numbered list of all targets for Claude to score in one call
      const targetsList = newResults.map((r, i) =>
        `[${i}] Title: ${r.title ?? 'N/A'}\nURL: ${r.link}\nSnippet: ${r.snippet ?? ''}`
      ).join('\n\n');

      const scorePrompt = scorePromptBase.replace('{{response_from_serper}}', targetsList);

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
        const result = newResults[item.index];
        if (!result) continue;
        console.log('[target_finder] Scored target:', result.link, '→', item.score, item.reason);

        let targetId;
        const isNewTarget = !result._existingTargetId;

        if (result._existingTargetId) {
          targetId = result._existingTargetId;
        } else {
          const { data: newTarget, error: insertError } = await getSupabaseAdmin()
            .from('targets')
            .insert({ domain: result._domain, title: result.title ?? null, link: result.link ?? null, snippet: result.snippet ?? null })
            .select('id').single();
          if (insertError) {
            console.error('[target_finder] Target insert error for', result.link, ':', insertError);
            continue;
          }
          targetId = newTarget.id;
        }

        // Only create lead rows for targets scoring above threshold
        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD) {
          const { error: leadError } = await getSupabaseAdmin()
            .from('leads')
            .insert({
              target_id: targetId,
              itp_id: itp.id,
              score: item.score ?? null,
              score_reason: item.reason ?? null,
              search_query_ids: [{ id: searchPromptId, position: result.position }],
            })
            .select('id').single();

          if (leadError) {
            console.error('[target_finder] Lead insert error for', result.link, ':', leadError);
          }
        }

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD && isNewTarget) {
          try {
            await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error('[target_finder] inline enrich_target error for', result.link, ':', err.message);
          }
        }
      }
    }
  }

  // Final count
  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, rejected, target_id, targets(id, title, link)')
    .eq('itp_id', itp.id);

  const highScoreTotal = (finalLeads ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;

  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'target_finder_ten_leads',
    user_details_id,
    output: {
      itp_id: itp.id,
      high_score_count: highScoreTotal,
      total_targets: (finalLeads ?? []).length,
    },
  });

  return { user_details_id, itp_id: itp.id, leads: finalLeads ?? [] };
}
