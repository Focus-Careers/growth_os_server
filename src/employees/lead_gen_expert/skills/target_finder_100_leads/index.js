import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { searchCompaniesHouseForItp } from '../target_finder_ten_leads/companies_house_search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 70;
const MAX_SERPER_ITERATIONS = 200;
const APOLLO_COMPANY_SEARCH_ENABLED = process.env.APOLLO_COMPANY_SEARCH_ENABLED === 'true';

async function callClaude(params, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await getAnthropic().messages.create(params);
    } catch (err) {
      if (err?.status === 429 && attempt < retries - 1) {
        const wait = 60000;
        console.log(`[target_finder_100] Rate limited, waiting ${wait / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

async function countApprovedLeads(itpId) {
  const { data } = await getSupabaseAdmin()
    .from('leads').select('id').eq('itp_id', itpId).eq('approved', true);
  return data?.length ?? 0;
}

async function buildDedupSets(accountId) {
  const [targetsRes, customersRes] = await Promise.all([
    getSupabaseAdmin().from('targets').select('domain, companies_house_number'),
    getSupabaseAdmin().from('customers').select('organisation_website').eq('account_id', accountId),
  ]);
  return {
    existingDomains: new Set((targetsRes.data ?? []).map(t => t.domain).filter(Boolean)),
    existingCHNumbers: new Set((targetsRes.data ?? []).map(t => t.companies_house_number).filter(Boolean)),
    customerDomains: new Set((customersRes.data ?? []).map(c => c.organisation_website?.toLowerCase()).filter(Boolean)),
  };
}

/**
 * After enrichment, add contacts to campaign and optionally sync to Smartlead.
 */
async function addContactsToCampaign(campaign_id, enrichResult, user_details_id) {
  if (!campaign_id || !enrichResult?.contacts?.length) return;
  const admin = getSupabaseAdmin();

  for (const contact of enrichResult.contacts) {
    const { error } = await admin
      .from('campaign_contacts')
      .insert({ campaign_id, contact_id: contact.id })
      .select('id').single();
    if (error && !error.message?.includes('duplicate')) {
      console.error('[target_finder_100] campaign_contacts insert error:', error.message);
    }
  }
  console.log(`[target_finder_100] Added ${enrichResult.contacts.length} contacts to campaign ${campaign_id}`);

  // Push to Smartlead if campaign is synced
  const { data: campaignRow } = await admin
    .from('campaigns').select('smartlead_campaign_id').eq('id', campaign_id).single();

  if (campaignRow?.smartlead_campaign_id) {
    try {
      const { addLeads } = await import('../../../../config/smartlead.js');
      const newContactIds = enrichResult.contacts.map(c => c.id);
      const { data: newContacts } = await admin
        .from('contacts')
        .select('id, first_name, last_name, email, role, phone, linkedin_url, target_id, targets(title, domain, company_location, industry)')
        .in('id', newContactIds);

      if (newContacts?.length) {
        const slLeads = newContacts.filter(c => c.email).map(c => ({
          email: c.email,
          first_name: c.first_name ?? '',
          last_name: c.last_name ?? '',
          company_name: c.targets?.title ?? '',
          website: c.targets?.domain ? `https://${c.targets.domain}` : '',
          custom_fields: { job_title: c.role ?? '', industry: c.targets?.industry ?? '' },
        }));

        await addLeads(parseInt(campaignRow.smartlead_campaign_id), slLeads);

        // Mark as synced
        const ccIds = [];
        for (const contact of enrichResult.contacts) {
          const { data: cc } = await admin
            .from('campaign_contacts').select('id')
            .eq('campaign_id', campaign_id).eq('contact_id', contact.id).maybeSingle();
          if (cc) ccIds.push(cc.id);
        }
        if (ccIds.length) {
          await admin.from('campaign_contacts').update({ smartlead_synced: true }).in('id', ccIds);
        }
        console.log(`[target_finder_100] Pushed ${slLeads.length} contacts to Smartlead`);
      }
    } catch (err) {
      console.error('[target_finder_100] Smartlead push error:', err.message);
    }
  }
}

export async function executeSkill({ user_details_id, itp_id, campaign_id }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();

  let itpQuery = admin.from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();

  if (!itp) throw new Error('No ITP found for account');

  const initialApprovedCount = await countApprovedLeads(itp.id);
  const targetCount = initialApprovedCount + 100;
  console.log(`[target_finder_100] Starting with ${initialApprovedCount} approved leads, aiming for ${targetCount}`);

  const { data: account } = await admin
    .from('account')
    .select('organisation_name, organisation_website, description, problem_solved')
    .eq('id', itp.account_id).single();

  const searchPromptTemplate = await readFile(join(__dirname, 'prompt_generate_google_search.md'), 'utf-8');
  const scorePromptTemplate = await readFile(join(__dirname, 'prompt_generate_company_score.md'), 'utf-8');
  // Use the structured score prompt from the ten_leads skill directory
  const structuredScoreTemplate = await readFile(
    join(__dirname, '..', 'target_finder_ten_leads', 'prompt_score_structured.md'), 'utf-8'
  );

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
      (str, [key, val]) => str.replaceAll(key, val), template
    );
  }

  const dedupSets = await buildDedupSets(userDetails.account_id);

  // ================================================================
  // PHASE 1: Companies House
  // ================================================================
  console.log('[target_finder_100] === PHASE 1: Companies House ===');

  try {
    const chResults = await searchCompaniesHouseForItp({
      itp,
      existingDomains: dedupSets.existingDomains,
      existingCHNumbers: dedupSets.existingCHNumbers,
      customerDomains: dedupSets.customerDomains,
    });

    if (chResults.length > 0) {
      const structuredList = chResults.map((c, i) =>
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
        max_tokens: 2048,
        messages: [{ role: 'user', content: scorePrompt }],
      });

      let scores = [];
      try {
        const raw = scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        scores = JSON.parse(raw);
      } catch { console.error('[target_finder_100] Failed to parse CH scores'); }

      for (const item of scores) {
        const chCompany = chResults[item.index];
        if (!chCompany) continue;

        const { data: newTarget, error } = await admin.from('targets').insert({
          domain: chCompany.domain,
          title: chCompany.companyName,
          link: chCompany.link,
          companies_house_number: chCompany.companyNumber,
          company_location: chCompany.location,
          industry: chCompany.sicDescription,
        }).select('id').single();

        if (error) continue;
        const targetId = newTarget.id;
        if (chCompany.domain) dedupSets.existingDomains.add(chCompany.domain);
        dedupSets.existingCHNumbers.add(chCompany.companyNumber);

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD) {
          await admin.from('leads').insert({
            target_id: targetId, itp_id: itp.id,
            score: item.score, score_reason: item.reason ?? null, approved: true,
          });

          // Save officers as contacts
          for (const officer of chCompany.officers) {
            if (!officer.first_name && !officer.last_name) continue;
            await admin.from('contacts').insert({
              target_id: targetId, account_id: userDetails.account_id,
              first_name: officer.first_name, last_name: officer.last_name,
              role: officer.role, email: null, source: 'companies_house',
            });
          }

          if (chCompany.domain) {
            try {
              const enrichResult = await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
              await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
              await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
              console.error(`[target_finder_100] CH enrich error: ${err.message}`);
            }
          }
        }
      }

      const currentCount = await countApprovedLeads(itp.id);
      if (currentCount >= targetCount) {
        console.log('[target_finder_100] Target reached after CH phase');
        return finalize(itp, user_details_id, targetCount);
      }
    }
  } catch (err) {
    console.error('[target_finder_100] CH phase error:', err.message);
  }

  // ================================================================
  // PHASE 2: Google/Serper backfill
  // ================================================================
  console.log('[target_finder_100] === PHASE 2: Google/Serper backfill ===');

  const scorePromptBase = fillTemplate(scorePromptTemplate);

  for (let iteration = 0; iteration < MAX_SERPER_ITERATIONS; iteration++) {
    const currentCount = await countApprovedLeads(itp.id);
    console.log(`[target_finder_100] Serper iteration ${iteration + 1}: ${currentCount}/${targetCount} approved`);
    if (currentCount >= targetCount) break;

    const { data: currentLeads } = await admin
      .from('leads')
      .select('id, target_id, score, score_reason, approved, search_query_ids, targets(id, domain, title, link)')
      .eq('itp_id', itp.id);

    let previousTargetsText = 'None yet.';
    let previousQueriesText = 'None yet.';

    const { data: allPreviousQueries } = await admin
      .from('target_finder_google_search_prompts').select('query')
      .eq('itp', itp.id).order('created_at', { ascending: true });

    if (allPreviousQueries?.length > 0) {
      previousQueriesText = allPreviousQueries.map((q, i) => `${i + 1}. ${q.query}`).join('\n');
    }
    if (currentLeads?.length > 0) {
      previousTargetsText = currentLeads.map(l =>
        `- Title: ${l.targets?.title ?? 'N/A'} | Website: ${l.targets?.link ?? 'N/A'} | Score: ${l.score ?? 'N/A'} | Reason: ${l.score_reason ?? 'N/A'}`
      ).join('\n');
    }

    const searchPrompt = fillTemplate(searchPromptTemplate, {
      '{{previous_targets}}': previousTargetsText,
      '{{previous_queries}}': previousQueriesText,
    });

    const searchResponse = await callClaude({
      model: 'claude-haiku-4-5-20251001', max_tokens: 256,
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const query = searchResponse.content[0].text.trim();
    console.log('[target_finder_100] Serper query:', query);

    const { data: insertedPrompt } = await admin
      .from('target_finder_google_search_prompts').insert({ itp: itp.id, query }).select('id').single();
    const searchPromptId = insertedPrompt?.id;

    const serperResponse = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 20, ...(itp.location ? { location: itp.location } : {}), hl: 'en' }),
    });

    const serperData = await serperResponse.json();
    if (!serperResponse.ok) { console.error('[target_finder_100] Serper error:', JSON.stringify(serperData)); break; }

    const organic = serperData.organic ?? [];
    const newResults = [];

    for (const result of organic) {
      if (!result.link) continue;
      let domain;
      try { domain = new URL(result.link).hostname.replace(/^www\./, ''); } catch { continue; }
      if (dedupSets.customerDomains.has(result.link.toLowerCase())) continue;

      if (dedupSets.existingDomains.has(domain)) {
        const { data: existingTarget } = await admin.from('targets').select('id').eq('domain', domain).maybeSingle();
        if (existingTarget) {
          const { data: existingLead } = await admin.from('leads').select('id, search_query_ids')
            .eq('target_id', existingTarget.id).eq('itp_id', itp.id).maybeSingle();
          if (existingLead) {
            await admin.from('leads').update({
              search_query_ids: [...(existingLead.search_query_ids ?? []), { id: searchPromptId, position: result.position }]
            }).eq('id', existingLead.id);
          } else {
            newResults.push({ ...result, _domain: domain, _existingTargetId: existingTarget.id });
          }
        }
        continue;
      }
      newResults.push({ ...result, _domain: domain, _existingTargetId: null });
    }

    if (newResults.length > 0) {
      const targetsList = newResults.map((r, i) =>
        `[${i}] Title: ${r.title ?? 'N/A'}\nURL: ${r.link}\nSnippet: ${r.snippet ?? ''}`
      ).join('\n\n');

      const scoreResponse = await callClaude({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: scorePromptBase.replace('{{response_from_serper}}', targetsList) }],
      });

      let scores = [];
      try {
        scores = JSON.parse(scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      } catch { console.error('[target_finder_100] Failed to parse Serper scores'); }

      for (const item of scores) {
        const result = newResults[item.index];
        if (!result) continue;

        let targetId;
        const isNewTarget = !result._existingTargetId;

        if (result._existingTargetId) {
          targetId = result._existingTargetId;
        } else {
          const { data: newTarget, error } = await admin.from('targets')
            .insert({ domain: result._domain, title: result.title ?? null, link: result.link ?? null })
            .select('id').single();
          if (error) continue;
          targetId = newTarget.id;
          dedupSets.existingDomains.add(result._domain);
        }

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD) {
          await admin.from('leads').insert({
            target_id: targetId, itp_id: itp.id,
            score: item.score, score_reason: item.reason ?? null, approved: true,
            search_query_ids: [{ id: searchPromptId, position: result.position }],
          });
        }

        if ((item.score ?? 0) >= HIGH_SCORE_THRESHOLD && isNewTarget) {
          try {
            const enrichResult = await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
            await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error('[target_finder_100] Serper enrich error:', err.message);
          }
        }
      }
    }
  }

  // ================================================================
  // PHASE 3: Apollo company search (optional)
  // ================================================================
  if (APOLLO_COMPANY_SEARCH_ENABLED) {
    const currentCount = await countApprovedLeads(itp.id);
    if (currentCount < targetCount) {
      console.log('[target_finder_100] === PHASE 3: Apollo company search ===');
      try {
        const { searchCompaniesByName } = await import('../../../../config/apollo.js');

        const apolloResponse = await callClaude({
          model: 'claude-haiku-4-5-20251001', max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Given this ITP, suggest 3-5 short keyword searches to find matching companies.\n\nITP: ${itp.itp_summary}\nDemographics: ${itp.itp_demographic}\nLocation: ${itp.location ?? 'UK'}\n\nRespond with a JSON array of search strings.`,
          }],
        });

        let searchTerms = [];
        try { searchTerms = JSON.parse(apolloResponse.content[0].text.trim()); } catch {}

        for (const term of searchTerms) {
          const orgs = await searchCompaniesByName(term, [itp.location ?? 'United Kingdom']);
          for (const org of orgs) {
            const domain = org.primary_domain;
            if (!domain || dedupSets.existingDomains.has(domain) || dedupSets.customerDomains.has(domain)) continue;

            const { data: newTarget } = await admin.from('targets')
              .insert({ domain, title: org.name ?? null, link: `https://${domain}`, industry: org.industry ?? null })
              .select('id').single();
            if (!newTarget) continue;
            dedupSets.existingDomains.add(domain);

            const targetsList = `[0] Title: ${org.name ?? 'N/A'}\nURL: https://${domain}\nSnippet: ${org.short_description ?? ''}`;
            const scoreRes = await callClaude({
              model: 'claude-sonnet-4-6', max_tokens: 256,
              messages: [{ role: 'user', content: scorePromptBase.replace('{{response_from_serper}}', targetsList) }],
            });

            let score = 0, reason = '';
            try {
              const parsed = JSON.parse(scoreRes.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
              score = parsed[0]?.score ?? 0;
              reason = parsed[0]?.reason ?? '';
            } catch {}

            if (score >= HIGH_SCORE_THRESHOLD) {
              await admin.from('leads').insert({
                target_id: newTarget.id, itp_id: itp.id, score, score_reason: reason, approved: true,
              });
              try {
                const enrichResult = await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true });
                await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
                await new Promise(r => setTimeout(r, 1000));
              } catch (err) {
                console.error('[target_finder_100] Apollo enrich error:', err.message);
              }
            }
          }
          const count = await countApprovedLeads(itp.id);
          if (count >= targetCount) break;
        }
      } catch (err) {
        console.error('[target_finder_100] Apollo phase error:', err.message);
      }
    }
  }

  return finalize(itp, user_details_id, targetCount);
}

async function finalize(itp, user_details_id, targetCount) {
  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, approved, target_id, targets(id, title, link)')
    .eq('itp_id', itp.id);

  const finalApprovedCount = (finalLeads ?? []).filter(l => l.approved).length;
  console.log(`[target_finder_100] Final: ${finalApprovedCount} approved leads`);

  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'target_finder_100_leads',
    user_details_id,
    output: {
      itp_id: itp.id,
      approved_count: finalApprovedCount,
      target_count: targetCount,
      total_leads: (finalLeads ?? []).length,
    },
  });

  return { user_details_id, itp_id: itp.id, leads: finalLeads ?? [] };
}
