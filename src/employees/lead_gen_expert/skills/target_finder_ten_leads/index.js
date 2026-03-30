import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { searchCompaniesHouseForItp } from './companies_house_search.js';
import { isDomainBlocked } from './domain_resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 70;
const TARGET_HIGH_SCORE_COUNT = 10;
const MAX_SERPER_ITERATIONS = 20;
const APOLLO_COMPANY_SEARCH_ENABLED = process.env.APOLLO_COMPANY_SEARCH_ENABLED === 'true';

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

/**
 * Count current high-score non-rejected leads for an ITP.
 */
async function countHighScoreLeads(itpId) {
  const { data } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, rejected')
    .eq('itp_id', itpId);
  return (data ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
}

/**
 * Build the set of existing domains, CH numbers, and customer domains for dedup.
 */
async function buildDedupSets(accountId) {
  const [targetsRes, customersRes] = await Promise.all([
    getSupabaseAdmin().from('targets').select('domain, companies_house_number'),
    getSupabaseAdmin().from('customers').select('organisation_website').eq('account_id', accountId),
  ]);

  const existingDomains = new Set(
    (targetsRes.data ?? []).map(t => t.domain).filter(Boolean)
  );
  const existingCHNumbers = new Set(
    (targetsRes.data ?? []).map(t => t.companies_house_number).filter(Boolean)
  );
  const customerDomains = new Set(
    (customersRes.data ?? []).map(c => c.organisation_website?.toLowerCase()).filter(Boolean)
  );

  return { existingDomains, existingCHNumbers, customerDomains };
}

export async function executeSkill({ user_details_id, itp_id }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details')
    .select('account_id')
    .eq('id', user_details_id)
    .single();

  // Load ITP
  let itpQuery = admin.from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();

  if (!itp) throw new Error('No ITP found for account');

  // Calculate dynamic target
  const initialHighScoreCount = await countHighScoreLeads(itp.id);
  const dynamicTarget = initialHighScoreCount + TARGET_HIGH_SCORE_COUNT;
  console.log(`[target_finder] Starting with ${initialHighScoreCount} existing high-score leads, aiming for ${dynamicTarget}`);

  // Load account info
  const { data: account } = await admin
    .from('account')
    .select('organisation_name, organisation_website, description, problem_solved')
    .eq('id', itp.account_id)
    .single();

  // Load prompt templates
  const searchPromptTemplate = await readFile(join(__dirname, 'prompt_generate_google_search.md'), 'utf-8');
  const scorePromptTemplate = await readFile(join(__dirname, 'prompt_generate_company_score.md'), 'utf-8');
  const structuredScoreTemplate = await readFile(join(__dirname, 'prompt_score_structured.md'), 'utf-8');

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
      (str, [key, val]) => str.replaceAll(key, val),
      template
    );
  }

  // Build dedup sets
  const dedupSets = await buildDedupSets(userDetails.account_id);

  // ================================================================
  // PHASE 1: Companies House (primary source)
  // ================================================================
  console.log('[target_finder] === PHASE 1: Companies House ===');

  try {
    const chResults = await searchCompaniesHouseForItp({
      itp,
      existingDomains: dedupSets.existingDomains,
      existingCHNumbers: dedupSets.existingCHNumbers,
      customerDomains: dedupSets.customerDomains,
    });

    if (chResults.length > 0) {
      // Score CH results in batches of 20 to avoid token limit truncation
      const CH_BATCH_SIZE = 20;
      const allScored = []; // { chCompany, score, reason }

      for (let batchStart = 0; batchStart < chResults.length; batchStart += CH_BATCH_SIZE) {
        const batch = chResults.slice(batchStart, batchStart + CH_BATCH_SIZE);
        console.log(`[target_finder] Scoring CH batch ${Math.floor(batchStart / CH_BATCH_SIZE) + 1}: companies ${batchStart + 1}-${batchStart + batch.length} of ${chResults.length}`);

        const structuredList = batch.map((c, i) =>
          `[${i}] Company: "${c.companyName}" (${c.domain ?? 'no website'})\n` +
          `    Industry (SIC): ${c.sicDescription}\n` +
          `    Location: ${c.location ?? 'Unknown'}\n` +
          `    Founded: ${c.dateOfCreation ?? 'Unknown'}\n` +
          `    Officers: ${c.officers.map(o => `${o.first_name ?? ''} ${o.last_name ?? ''} (${o.role ?? 'unknown role'})`).join(', ') || 'None listed'}\n` +
          `    Company Number: ${c.companyNumber}`
        ).join('\n\n');

        const scorePrompt = fillTemplate(structuredScoreTemplate, {
          '{{structured_companies}}': structuredList,
        });

        const scoreResponse = await callClaude({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          messages: [{ role: 'user', content: scorePrompt }],
        });

        let scores = [];
        try {
          const raw = scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
          scores = JSON.parse(raw);
        } catch (e) {
          console.error(`[target_finder] Failed to parse CH batch scores:`, scoreResponse.content[0].text.slice(0, 200));
          continue;
        }

        for (const item of scores) {
          const chCompany = batch[item.index];
          if (chCompany) allScored.push({ chCompany, score: item.score, reason: item.reason });
        }
      }

      let chLeadsCreated = 0;
      for (const { chCompany, score, reason } of allScored) {
        // Stop once we've hit the target — don't create more leads than needed
        if (initialHighScoreCount + chLeadsCreated >= dynamicTarget) {
          console.log(`[target_finder] CH phase: reached ${dynamicTarget} leads, stopping early`);
          break;
        }

        const item = { score, reason };
        if (!chCompany) continue;

        // Skip low-score companies (don't even create the target)
        if ((item.score ?? 0) < HIGH_SCORE_THRESHOLD) continue;

        console.log(`[target_finder] CH scored: ${chCompany.companyName} → ${item.score} (${item.reason})`);

        // Create target
        const targetInsert = {
          domain: chCompany.domain,
          title: chCompany.companyName,
          link: chCompany.link,
          companies_house_number: chCompany.companyNumber,
          company_location: chCompany.location,
          industry: chCompany.sicDescription,
        };

        const { data: newTarget, error: insertError } = await admin
          .from('targets')
          .insert(targetInsert)
          .select('id')
          .single();

        if (insertError) {
          console.error('[target_finder] CH target insert error:', insertError);
          continue;
        }

        const targetId = newTarget.id;

        // Add to dedup sets
        if (chCompany.domain) dedupSets.existingDomains.add(chCompany.domain);
        dedupSets.existingCHNumbers.add(chCompany.companyNumber);

        // Create lead
        await admin.from('leads').insert({
          target_id: targetId,
          itp_id: itp.id,
          score: item.score,
          score_reason: item.reason ?? null,
        });
        chLeadsCreated++;

        // Save officers as contacts BEFORE enrichment
        for (const officer of chCompany.officers) {
          if (!officer.first_name && !officer.last_name) continue;
          await admin.from('contacts').insert({
            target_id: targetId,
            account_id: userDetails.account_id,
            first_name: officer.first_name,
            last_name: officer.last_name,
            role: officer.role,
            email: null,
            source: 'companies_house',
          });
        }

        // Run enrichment (scrape + Apollo reveal for officers' emails)
        if (chCompany.domain) {
          try {
            await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error(`[target_finder] CH enrich error for ${chCompany.companyName}:`, err.message);
          }
        }
      }

      // Check if we've hit target
      const currentCount = await countHighScoreLeads(itp.id);
      console.log(`[target_finder] After CH phase: ${currentCount}/${dynamicTarget} high-score leads`);
      if (currentCount >= dynamicTarget) {
        console.log('[target_finder] Target reached after CH phase, skipping Serper backfill');
        return finalize(itp, user_details_id);
      }
    }
  } catch (err) {
    console.error('[target_finder] Companies House phase error:', err.message);
    // Continue to Serper backfill
  }

  // ================================================================
  // PHASE 2: Google/Serper backfill
  // ================================================================
  console.log('[target_finder] === PHASE 2: Google/Serper backfill ===');

  const scorePromptBase = fillTemplate(scorePromptTemplate);

  for (let iteration = 0; iteration < MAX_SERPER_ITERATIONS; iteration++) {
    const currentCount = await countHighScoreLeads(itp.id);
    console.log(`[target_finder] Serper iteration ${iteration + 1}: ${currentCount}/${dynamicTarget} high-score leads`);
    if (currentCount >= dynamicTarget) {
      console.log('[target_finder] Target reached, stopping Serper backfill.');
      break;
    }

    // Build context for search query generation
    const { data: currentLeads } = await admin
      .from('leads')
      .select('id, target_id, score, score_reason, rejected, search_query_ids, targets(id, domain, title, link)')
      .eq('itp_id', itp.id);

    let previousTargetsText = 'None yet.';
    let previousQueriesText = 'None yet.';

    const { data: allPreviousQueries } = await admin
      .from('target_finder_google_search_prompts')
      .select('query')
      .eq('itp', itp.id)
      .order('created_at', { ascending: true });

    if (allPreviousQueries?.length > 0) {
      previousQueriesText = allPreviousQueries.map((q, i) => `${i + 1}. ${q.query}`).join('\n');
    }
    if (currentLeads?.length > 0) {
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
    console.log('[target_finder] Serper query:', query);

    const { data: insertedPrompt } = await admin
      .from('target_finder_google_search_prompts')
      .insert({ itp: itp.id, query })
      .select('id')
      .single();

    const searchPromptId = insertedPrompt?.id;

    // Call Serper
    const serperResponse = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
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

    // Dedup and collect new results
    const newResults = [];
    for (const result of organic) {
      if (!result.link) continue;

      let domain;
      try { domain = new URL(result.link).hostname.replace(/^www\./, ''); } catch { continue; }

      if (dedupSets.customerDomains.has(result.link.toLowerCase())) continue;
      if (isDomainBlocked(domain)) continue;
      if (dedupSets.existingDomains.has(domain)) {
        // Check if lead already exists
        const { data: existingTarget } = await admin
          .from('targets').select('id').eq('domain', domain).maybeSingle();
        if (existingTarget) {
          const { data: existingLead } = await admin
            .from('leads').select('id, search_query_ids').eq('target_id', existingTarget.id).eq('itp_id', itp.id).maybeSingle();
          if (existingLead) {
            const updatedQueryIds = [...(existingLead.search_query_ids ?? []), { id: searchPromptId, position: result.position }];
            await admin.from('leads').update({ search_query_ids: updatedQueryIds }).eq('id', existingLead.id);
          } else {
            newResults.push({ ...result, _domain: domain, _existingTargetId: existingTarget.id });
          }
        }
        continue;
      }

      newResults.push({ ...result, _domain: domain, _existingTargetId: null });
    }

    console.log('[target_finder] New Serper results to score:', newResults.length);

    if (newResults.length > 0) {
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
        scores = JSON.parse(raw);
      } catch (e) {
        console.error('[target_finder] Failed to parse Serper scores:', scoreResponse.content[0].text);
      }

      for (const item of scores) {
        const result = newResults[item.index];
        if (!result) continue;
        console.log('[target_finder] Serper scored:', result.link, '→', item.score, item.reason);

        let targetId;
        const isNewTarget = !result._existingTargetId;

        if (result._existingTargetId) {
          targetId = result._existingTargetId;
        } else {
          const { data: newTarget, error: insertError } = await admin
            .from('targets')
            .insert({ domain: result._domain, title: result.title ?? null, link: result.link ?? null })
            .select('id').single();
          if (insertError) {
            console.error('[target_finder] Serper target insert error:', insertError);
            continue;
          }
          targetId = newTarget.id;
          dedupSets.existingDomains.add(result._domain);
        }

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD) {
          await admin.from('leads').insert({
            target_id: targetId,
            itp_id: itp.id,
            score: item.score ?? null,
            score_reason: item.reason ?? null,
            search_query_ids: [{ id: searchPromptId, position: result.position }],
          });
        }

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD && isNewTarget) {
          try {
            await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error('[target_finder] Serper enrich error:', err.message);
          }
        }
      }
    }
  }

  // ================================================================
  // PHASE 3: Apollo company search (optional)
  // ================================================================
  if (APOLLO_COMPANY_SEARCH_ENABLED) {
    const currentCount = await countHighScoreLeads(itp.id);
    if (currentCount < dynamicTarget) {
      console.log('[target_finder] === PHASE 3: Apollo company search ===');
      try {
        const { searchCompaniesByName } = await import('../../../../config/apollo.js');

        // Generate Apollo search terms from ITP
        const apolloResponse = await callClaude({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Given this ITP, suggest 3-5 short keyword searches to find matching companies on a business database.\n\nITP: ${itp.itp_summary}\nDemographics: ${itp.itp_demographic}\nLocation: ${itp.location ?? 'UK'}\n\nRespond with a JSON array of search strings, e.g. ["joinery contractor", "bespoke furniture maker"]`,
          }],
        });

        let searchTerms = [];
        try { searchTerms = JSON.parse(apolloResponse.content[0].text.trim()); } catch {}

        for (const term of searchTerms) {
          const orgs = await searchCompaniesByName(term, [itp.location ?? 'United Kingdom']);
          for (const org of orgs) {
            const domain = org.primary_domain;
            if (!domain || dedupSets.existingDomains.has(domain) || dedupSets.customerDomains.has(domain)) continue;

            // Create target + score inline (simplified)
            const { data: newTarget } = await admin
              .from('targets')
              .insert({ domain, title: org.name ?? null, link: `https://${domain}`, industry: org.industry ?? null })
              .select('id').single();

            if (!newTarget) continue;
            dedupSets.existingDomains.add(domain);

            // Score with Serper prompt (treating Apollo data like a search result)
            const targetsList = `[0] Title: ${org.name ?? 'N/A'}\nURL: https://${domain}\nSnippet: ${org.short_description ?? ''}`;
            const scorePrompt = scorePromptBase.replace('{{response_from_serper}}', targetsList);
            const scoreRes = await callClaude({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [{ role: 'user', content: scorePrompt }] });

            let score = 0, reason = '';
            try {
              const parsed = JSON.parse(scoreRes.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
              score = parsed[0]?.score ?? 0;
              reason = parsed[0]?.reason ?? '';
            } catch {}

            if (score >= HIGH_SCORE_THRESHOLD) {
              await admin.from('leads').insert({ target_id: newTarget.id, itp_id: itp.id, score, score_reason: reason });
              try {
                await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true });
                await new Promise(r => setTimeout(r, 1000));
              } catch (err) {
                console.error('[target_finder] Apollo enrich error:', err.message);
              }
            }
          }

          // Check target
          const count = await countHighScoreLeads(itp.id);
          if (count >= dynamicTarget) break;
        }
      } catch (err) {
        console.error('[target_finder] Apollo company search phase error:', err.message);
      }
    }
  }

  return finalize(itp, user_details_id);
}

async function finalize(itp, user_details_id) {
  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, rejected, target_id, targets(id, title, link)')
    .eq('itp_id', itp.id);

  const highScoreTotal = (finalLeads ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
  console.log(`[target_finder] Final: ${highScoreTotal} high-score leads`);

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
