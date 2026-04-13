import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { searchCompaniesHouseForItp } from '../target_finder_ten_leads/companies_house_search.js';
import { isDomainBlocked, resolveDomain } from '../target_finder_ten_leads/domain_resolver.js';
import { buildSearchProfile } from '../target_finder_ten_leads/build_search_profile.js';
import { shouldSkipCompany } from '../target_finder_ten_leads/company_filter.js';
import { searchCompanies as searchCH, getCompanyProfile } from '../../../../config/companies_house.js';
import { enrichCompany } from '../../../../config/apollo.js';
import { openRun, increment, closeRun } from '../../../../lib/cost_tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 50;
const TARGET_LEAD_COUNT = 100;
const CH_BATCH_SIZE = 20;
const MAX_SERPER_ITERATIONS = 50;
const APOLLO_COMPANY_SEARCH_ENABLED = process.env.APOLLO_COMPANY_SEARCH_ENABLED === 'true';

async function callClaude({ model, max_completion_tokens, system, messages, ...rest }, retries = 3) {
  const openaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  // GPT-5 family are reasoning models — cap reasoning to "low" for simple scoring/extraction tasks
  // and use a higher token budget so reasoning doesn't consume everything before output starts
  const params = { model, max_completion_tokens: Math.max(max_completion_tokens * 4, 8192), reasoning_effort: 'low', messages: openaiMessages, ...rest };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await getOpenAI().chat.completions.create(params);
      const choice = res.choices[0];
      // Wrap response to match Anthropic shape used throughout this file
      return { content: [{ text: choice.message.content ?? '' }] };
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
  const admin = getSupabaseAdmin();

  // targets has no account_id — resolve via leads → itp → account_id
  const { data: itpData } = await admin.from('itp').select('id').eq('account_id', accountId);
  const itpIds = (itpData ?? []).map(i => i.id);

  let accountTargetDomains = [];
  let accountTargetCHNumbers = [];
  if (itpIds.length) {
    const { data: leadsData } = await admin.from('leads').select('target_id').in('itp_id', itpIds);
    const targetIds = [...new Set((leadsData ?? []).map(l => l.target_id).filter(Boolean))];
    if (targetIds.length) {
      const { data: targetsData } = await admin
        .from('targets').select('domain, companies_house_number').in('id', targetIds);
      accountTargetDomains = (targetsData ?? []).map(t => t.domain).filter(Boolean);
      accountTargetCHNumbers = (targetsData ?? []).map(t => t.companies_house_number).filter(Boolean);
    }
  }

  const { data: customersData } = await admin
    .from('customers').select('organisation_website').eq('account_id', accountId);

  return {
    existingDomains: new Set(accountTargetDomains),
    existingCHNumbers: new Set(accountTargetCHNumbers),
    customerDomains: new Set((customersData ?? []).map(c => c.organisation_website?.toLowerCase()).filter(Boolean)),
  };
}

function buildBuyerContext(searchProfile) {
  const parts = [];
  if (searchProfile.buyer_descriptions?.length) {
    parts.push(`The types of businesses that typically buy from this company include: ${searchProfile.buyer_descriptions.join(', ')}.`);
  }
  if (searchProfile.customer_sic_codes?.length) {
    parts.push(`Existing customers are commonly registered under SIC codes: ${searchProfile.customer_sic_codes.join(', ')}.`);
  }
  return parts.length > 0 ? parts.join(' ') : '';
}

/**
 * Resolve domain + Apollo company enrichment for all candidates before scoring.
 * Deduplicates against existing domains so we don't spend Apollo credits on companies
 * we already have. Returns only companies that should proceed to scoring.
 */
async function preEnrichForScoring(companies, dedupSets) {
  const results = [];
  for (const company of companies) {
    const domain = await resolveDomain(company.companyName, company.location);

    if (domain) {
      if (dedupSets.existingDomains.has(domain) || dedupSets.customerDomains.has(domain)) {
        console.log(`[target_finder_100] Pre-enrich dedup: ${company.companyName} — ${domain} already seen`);
        continue;
      }
    }

    let apolloData = null;
    if (domain) {
      try {
        apolloData = await enrichCompany(domain);
      } catch (err) {
        console.error(`[target_finder_100] Pre-enrich Apollo error for ${company.companyName}:`, err.message);
      }
    }

    results.push({ ...company, domain: domain ?? null, apolloData });
  }
  return results;
}

async function scoreStructuredBatch(companies, fillTemplate, structuredScoreTemplate, buyerContext) {
  const structuredList = companies.map((c, i) => {
    let entry =
      `[${i}] Company: "${c.companyName}" (${c.domain ?? 'no website'})\n` +
      `    Industry (SIC): ${c.sicDescription}\n` +
      `    Location: ${c.location ?? 'Unknown'}\n` +
      `    Founded: ${c.dateOfCreation ?? 'Unknown'}\n` +
      `    Officers: ${c.officers?.map(o => `${o.first_name ?? ''} ${o.last_name ?? ''} (${o.role ?? 'unknown role'})`).join(', ') || 'None listed'}\n` +
      `    Company Number: ${c.companyNumber}`;
    if (c.apolloData) {
      const a = c.apolloData;
      const parts = [];
      if (a.short_description) parts.push(`Description: ${a.short_description}`);
      if (a.industry) parts.push(`Industry: ${a.industry}`);
      if (a.estimated_num_employees) parts.push(`Employees: ~${a.estimated_num_employees}`);
      if (a.annual_revenue_printed) parts.push(`Revenue: ${a.annual_revenue_printed}`);
      if (a.country) parts.push(`Country: ${a.country}`);
      if (parts.length) entry += '\n    Apollo: ' + parts.join(' | ');
    }
    return entry;
  }).join('\n\n');

  const scorePrompt = fillTemplate(structuredScoreTemplate, {
    '{{structured_companies}}': structuredList,
    '{{buyer_context}}': buyerContext,
  });

  const scoreResponse = await callClaude({
    model: 'gpt-5-mini', max_completion_tokens: 2048,
    messages: [{ role: 'user', content: scorePrompt }],
  });

  try {
    const raw = scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(raw);
  } catch {
    const preview = scoreResponse.content[0]?.text?.slice(0, 300) ?? '(empty)';
    console.error(`[target_finder_100] Failed to parse scores. Response preview: ${preview}`);
    return [];
  }
}

async function addContactsToCampaign(campaign_id, enrichResult, user_details_id) {
  if (!campaign_id || !enrichResult?.contacts?.length) return;
  const admin = getSupabaseAdmin();

  // Filter out contacts already in this campaign to avoid wasted DB writes and API calls
  const incomingIds = enrichResult.contacts.map(c => c.id);
  const { data: alreadyIn } = await admin
    .from('campaign_contacts').select('contact_id')
    .eq('campaign_id', campaign_id).in('contact_id', incomingIds);
  const alreadyInSet = new Set((alreadyIn ?? []).map(r => r.contact_id));
  const newContacts = enrichResult.contacts.filter(c => !alreadyInSet.has(c.id));

  if (!newContacts.length) return;

  for (const contact of newContacts) {
    const { error } = await admin
      .from('campaign_contacts')
      .insert({ campaign_id, contact_id: contact.id })
      .select('id').single();
    if (error && !error.message?.includes('duplicate')) {
      console.error('[target_finder_100] campaign_contacts insert error:', error.message);
    }
  }
  console.log(`[target_finder_100] Added ${newContacts.length} contacts to campaign ${campaign_id}`);

  const { data: campaignRow } = await admin
    .from('campaigns').select('smartlead_campaign_id').eq('id', campaign_id).single();

  if (campaignRow?.smartlead_campaign_id) {
    try {
      const { addLeads } = await import('../../../../config/smartlead.js');
      const newContactIds = newContacts.map(c => c.id);
      const { data: contactRows } = await admin
        .from('contacts')
        .select('id, first_name, last_name, email, role, phone, linkedin_url, target_id, targets(title, domain, company_location, industry)')
        .in('id', newContactIds);

      if (contactRows?.length) {
        const slLeads = contactRows.filter(c => c.email).map(c => ({
          email: c.email,
          first_name: c.first_name ?? '',
          last_name: c.last_name ?? '',
          company_name: c.targets?.title ?? '',
          website: c.targets?.domain ? `https://${c.targets.domain}` : '',
          custom_fields: { job_title: c.role ?? '', industry: c.targets?.industry ?? '' },
        }));

        const slCampaignId = parseInt(campaignRow.smartlead_campaign_id);
        if (isNaN(slCampaignId)) {
          console.warn(`[target_finder_100] smartlead_campaign_id "${campaignRow.smartlead_campaign_id}" is not a valid integer — skipping Smartlead push`);
          return;
        }
        await addLeads(slCampaignId, slLeads);

        const ccIds = [];
        for (const contact of newContacts) {
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

async function createLeadFromCH(chCompany, score, reason, itp, accountId, user_details_id, campaign_id, dedupSets) {
  const admin = getSupabaseAdmin();

  // Domain already resolved in preEnrichForScoring — no Serper call needed here.
  const domain = chCompany.domain ?? null;

  // Dedup double-check (in case state changed since pre-enrichment)
  if (domain && (dedupSets.existingDomains.has(domain) || dedupSets.customerDomains.has(domain))) {
    console.log(`[target_finder_100] Skipping ${chCompany.companyName} — domain ${domain} already seen`);
    return;
  }

  const { data: newTarget, error } = await admin.from('targets').insert({
    domain, title: chCompany.companyName, link: domain ? `https://${domain}` : null,
    companies_house_number: chCompany.companyNumber,
    company_location: chCompany.location, industry: chCompany.sicDescription,
  }).select('id').single();

  if (error) { console.error('[target_finder_100] Target insert error:', error); return; }

  const targetId = newTarget.id;
  if (domain) dedupSets.existingDomains.add(domain);
  if (chCompany.companyNumber) dedupSets.existingCHNumbers.add(chCompany.companyNumber);

  await admin.from('leads').insert({
    target_id: targetId, itp_id: itp.id, score, score_reason: reason ?? null, approved: true,
  });

  for (const officer of (chCompany.officers ?? [])) {
    if (!officer.first_name && !officer.last_name) continue;
    await admin.from('contacts').insert({
      target_id: targetId, account_id: accountId,
      first_name: officer.first_name, last_name: officer.last_name,
      role: officer.role, email: null, source: 'companies_house',
    });
  }

  if (domain) {
    try {
      const enrichResult = await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
      await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[target_finder_100] Enrich error for ${chCompany.companyName}:`, err.message);
    }
  }
}

// ====================================================================
// MAIN SKILL
// ====================================================================

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
  const targetCount = initialApprovedCount + TARGET_LEAD_COUNT;
  console.log(`[target_finder_100] Starting with ${initialApprovedCount} approved leads, aiming for ${targetCount}`);

  const runId = await openRun({
    account_id: userDetails.account_id,
    itp_id: itp.id,
    campaign_id: campaign_id ?? null,
    user_details_id,
  });

  const { data: account } = await admin
    .from('account')
    .select('organisation_name, organisation_website, description, problem_solved')
    .eq('id', itp.account_id).single();

  const { data: customers } = await admin
    .from('customers').select('organisation_name, organisation_website')
    .eq('account_id', userDetails.account_id);

  let customerAnalysis = null;
  if (customers?.length > 0) {
    customerAnalysis = { customerSicCodes: [], customerLocations: [] };
  }

  // ── Build Search Profile ───────────────────────────────────────────
  console.log('[target_finder_100] Building search profile...');
  const searchProfile = await buildSearchProfile(itp, account, customerAnalysis);
  const buyerContext = buildBuyerContext(searchProfile);

  // Load prompt templates
  const structuredScoreTemplate = await readFile(
    join(__dirname, '..', 'target_finder_ten_leads', 'prompt_score_structured.md'), 'utf-8'
  );
  const hybridScoreTemplate = await readFile(
    join(__dirname, '..', 'target_finder_ten_leads', 'prompt_score_hybrid.md'), 'utf-8'
  );
  const searchPromptTemplate = await readFile(join(__dirname, 'prompt_generate_google_search.md'), 'utf-8');

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
  // STEP 1: Customer Lookalike Search (highest quality)
  // ================================================================
  if (searchProfile.customer_sic_codes?.length > 0) {
    console.log('[target_finder_100] === STEP 1: Customer Lookalike ===');

    try {
      const chResults = await searchCompaniesHouseForItp({
        itp: { ...itp, sic_codes: searchProfile.customer_sic_codes },
        existingDomains: dedupSets.existingDomains,
        existingCHNumbers: dedupSets.existingCHNumbers,
        customerDomains: dedupSets.customerDomains,
      });

      const filtered = chResults.filter(c => !shouldSkipCompany(c, searchProfile));
      console.log(`[target_finder_100] Step 1: ${chResults.length} found, ${filtered.length} after pre-filter`);
      await increment(runId, { ch_companies_found: chResults.length, ch_companies_after_filter: filtered.length });

      if (filtered.length > 0) {
        console.log(`[target_finder_100] Step 1: pre-enriching ${filtered.length} companies for scoring...`);
        const enriched = await preEnrichForScoring(filtered, dedupSets);
        await increment(runId, { serper_calls_used: filtered.length }); // 1 Serper call per company for domain resolution

        const allScored = [];
        for (let i = 0; i < enriched.length; i += CH_BATCH_SIZE) {
          const batch = enriched.slice(i, i + CH_BATCH_SIZE);
          console.log(`[target_finder_100] Step 1 scoring batch ${Math.floor(i / CH_BATCH_SIZE) + 1}`);
          const scores = await scoreStructuredBatch(batch, fillTemplate, structuredScoreTemplate, buyerContext);
          await increment(runId, { haiku_calls_used: 1 });
          for (const item of scores) {
            if (batch[item.index]) allScored.push({ company: batch[item.index], score: item.score, reason: item.reason });
          }
        }

        for (const { company, score, reason } of allScored) {
          if ((score ?? 0) < HIGH_SCORE_THRESHOLD) continue;
          await createLeadFromCH(company, score, reason, itp, userDetails.account_id, user_details_id, campaign_id, dedupSets);
        }

        const count = await countApprovedLeads(itp.id);
        console.log(`[target_finder_100] After Step 1: ${count}/${targetCount}`);
        if (count >= targetCount) return finalize(itp, user_details_id, targetCount, runId);
      }
    } catch (err) {
      console.error('[target_finder_100] Step 1 error:', err.message);
    }
  }

  // ================================================================
  // STEP 2: CH Broad Search (backfill before trying Google)
  // ================================================================
  console.log('[target_finder_100] === STEP 2: CH Broad Search ===');

  try {
    const chResults = await searchCompaniesHouseForItp({
      itp,
      existingDomains: dedupSets.existingDomains,
      existingCHNumbers: dedupSets.existingCHNumbers,
      customerDomains: dedupSets.customerDomains,
    });

    const filtered = chResults.filter(c => {
      const reason = shouldSkipCompany(c, searchProfile);
      if (reason) console.log(`[target_finder_100] Pre-filter skip: ${c.companyName} — ${reason}`);
      return !reason;
    });
    console.log(`[target_finder_100] Step 2: ${chResults.length} found, ${filtered.length} after pre-filter`);
    await increment(runId, { ch_companies_found: chResults.length, ch_companies_after_filter: filtered.length });

    if (filtered.length > 0) {
      console.log(`[target_finder_100] Step 2: pre-enriching ${filtered.length} companies for scoring...`);
      const enriched = await preEnrichForScoring(filtered, dedupSets);
      await increment(runId, { serper_calls_used: filtered.length });

      for (let i = 0; i < enriched.length; i += CH_BATCH_SIZE) {
        const batch = enriched.slice(i, i + CH_BATCH_SIZE);
        console.log(`[target_finder_100] Step 2 scoring batch ${Math.floor(i / CH_BATCH_SIZE) + 1}`);
        const scores = await scoreStructuredBatch(batch, fillTemplate, structuredScoreTemplate, buyerContext);
        await increment(runId, { haiku_calls_used: 1 });

        for (const item of scores) {
          const company = batch[item.index];
          if (!company || (item.score ?? 0) < HIGH_SCORE_THRESHOLD) continue;
          await createLeadFromCH(company, item.score, item.reason, itp, userDetails.account_id, user_details_id, campaign_id, dedupSets);
        }

        const count = await countApprovedLeads(itp.id);
        if (count >= targetCount) break;
      }
    }
  } catch (err) {
    console.error('[target_finder_100] Step 2 error:', err.message);
  }

  {
    const count = await countApprovedLeads(itp.id);
    console.log(`[target_finder_100] After Step 2: ${count}/${targetCount}`);
    if (count >= targetCount) return finalize(itp, user_details_id, targetCount, runId);
  }

  // ================================================================
  // STEP 3: Targeted Google Search (fallback if CH alone not enough)
  // ================================================================
  console.log('[target_finder_100] === STEP 3: Targeted Google Search ===');

  const scorePromptBase = fillTemplate(hybridScoreTemplate, { '{{buyer_context}}': buyerContext });

  // Run pre-generated search profile queries first, then generate dynamically
  const profileQueries = searchProfile.search_queries ?? [];
  let serperIterations = 0;

  async function runSerperQuery(query) {
    serperIterations++;
    const count = await countApprovedLeads(itp.id);
    if (count >= targetCount) return false;

    console.log(`[target_finder_100] Google query (${serperIterations}): ${query}`);

    await increment(runId, { serper_calls_used: 1 });
    const serperRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 20, ...(itp.location ? { location: itp.location } : {}), hl: 'en' }),
    });
    const serperData = await serperRes.json();
    if (!serperRes.ok) { console.error('[target_finder_100] Serper error:', JSON.stringify(serperData)); return true; }

    const organic = serperData.organic ?? [];
    const newResults = [];

    // Skip results that are clearly not company homepages
    const JUNK_TITLE_PATTERNS = /^\[pdf\]|^\[doc\]|catalogue|brochure|directory|magazine|journal|news|wikipedia|linkedin\.com|facebook\.com|twitter\.com|instagram\.com|youtube\.com/i;

    const seenInQuery = new Set();
    for (const result of organic) {
      if (!result.link) continue;
      if (JUNK_TITLE_PATTERNS.test(result.title ?? '')) continue;
      let domain;
      try { domain = new URL(result.link).hostname.replace(/^www\./, ''); } catch { continue; }
      if (isDomainBlocked(domain)) continue;
      if (dedupSets.existingDomains.has(domain)) continue;
      if (dedupSets.customerDomains.has(domain)) continue;
      if (seenInQuery.has(domain)) continue; // within-query dedup
      seenInQuery.add(domain);
      newResults.push({ ...result, _domain: domain });
    }

    if (newResults.length === 0) return true;

    // Cross-reference with CH for structured data
    const hybridList = [];
    for (const result of newResults) {
      let chData = null;
      // Strip suffix noise like "- Home", "| Products", "– Welcome"
      const companyName = result.title
        ?.replace(/\s*[-|–|:]\s*(home|welcome|products|services|about|contact|uk|official site|website).*$/i, '')
        ?.replace(/\s*[-|–]\s*.*$/, '')
        ?.trim();
      // Only do CH lookup for homepage results with short titles (articles have long titles)
      let isHomepage = false;
      try { const u = new URL(result.link); isHomepage = u.pathname === '/' || u.pathname === '' || u.pathname === '/index.html'; } catch {}
      if (companyName && companyName.length <= 50 && isHomepage) {
        try {
          const chSearch = await searchCH({ companyName, size: 3 });
          const match = (chSearch.items ?? []).find(item =>
            item.company_name?.toUpperCase().includes(companyName.toUpperCase().slice(0, 20))
          );
          if (match) {
            const profile = await getCompanyProfile(match.company_number);
            if (profile) {
              chData = {
                companyNumber: match.company_number,
                sicCodes: profile.sic_codes ?? [],
                dateOfCreation: profile.date_of_creation,
                location: [profile.registered_office_address?.locality, profile.registered_office_address?.region].filter(Boolean).join(', '),
              };
            }
          }
        } catch {} // CH cross-ref is best-effort
      }
      hybridList.push({ index: hybridList.length, title: result.title, link: result.link, snippet: result.snippet, domain: result._domain, chData });
    }

    const targetsList = hybridList.map((h, i) => {
      let entry = `[${i}] Title: ${h.title ?? 'N/A'}\n    URL: ${h.link}\n    Snippet: ${h.snippet ?? ''}`;
      if (h.chData) {
        entry += `\n    [Companies House verified] SIC: ${h.chData.sicCodes.join(', ')} | Founded: ${h.chData.dateOfCreation ?? 'Unknown'} | Location: ${h.chData.location ?? 'Unknown'}`;
      }
      return entry;
    }).join('\n\n');

    const scorePrompt = scorePromptBase.replace('{{hybrid_companies}}', targetsList);
    await increment(runId, { haiku_calls_used: 1 });
    const scoreRes = await callClaude({ model: 'gpt-5-mini', max_completion_tokens: 1024, messages: [{ role: 'user', content: scorePrompt }] });

    let scores = [];
    try {
      scores = JSON.parse(scoreRes.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    } catch { console.error('[target_finder_100] Failed to parse Google scores'); return true; }

    for (const item of scores) {
      const h = hybridList[item.index];
      if (!h || (item.score ?? 0) < HIGH_SCORE_THRESHOLD) continue;

      const { data: newTarget, error } = await admin.from('targets').insert({
        domain: h.domain, title: h.title ?? null, link: h.link ?? null,
        companies_house_number: h.chData?.companyNumber ?? null,
      }).select('id').single();
      if (error) continue;

      dedupSets.existingDomains.add(h.domain);
      if (h.chData?.companyNumber) dedupSets.existingCHNumbers.add(h.chData.companyNumber);

      await admin.from('leads').insert({
        target_id: newTarget.id, itp_id: itp.id, score: item.score, score_reason: item.reason ?? null, approved: true,
      });

      try {
        const enrichResult = await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true });
        await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) { console.error('[target_finder_100] Google enrich error:', err.message); }
    }

    return true;
  }

  // Run profile queries first
  for (const query of profileQueries) {
    const shouldContinue = await runSerperQuery(query);
    if (!shouldContinue) break;
  }

  // Generate additional queries dynamically if still below target
  let dynamicIterations = 0;
  const maxDynamicIterations = MAX_SERPER_ITERATIONS - profileQueries.length;

  while (dynamicIterations < maxDynamicIterations) {
    const count = await countApprovedLeads(itp.id);
    if (count >= targetCount) break;
    dynamicIterations++;

    const { data: currentLeads } = await admin
      .from('leads')
      .select('id, score, score_reason, targets(domain, title, link)')
      .eq('itp_id', itp.id);

    const { data: allPreviousQueries } = await admin
      .from('target_finder_google_search_prompts').select('query')
      .eq('itp', itp.id).order('created_at', { ascending: true });

    const previousQueriesText = allPreviousQueries?.length > 0
      ? allPreviousQueries.map((q, i) => `${i + 1}. ${q.query}`).join('\n')
      : 'None yet.';
    const previousTargetsText = currentLeads?.length > 0
      ? currentLeads.map(l => `- Title: ${l.targets?.title ?? 'N/A'} | Website: ${l.targets?.link ?? 'N/A'} | Score: ${l.score ?? 'N/A'} | Reason: ${l.score_reason ?? 'N/A'}`).join('\n')
      : 'None yet.';

    const searchPrompt = fillTemplate(searchPromptTemplate, {
      '{{previous_targets}}': previousTargetsText,
      '{{previous_queries}}': previousQueriesText,
    });

    await increment(runId, { haiku_calls_used: 1 });
    const searchResponse = await callClaude({
      model: 'gpt-5-mini', max_completion_tokens: 256,
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const query = searchResponse.content[0].text.trim();
    await admin.from('target_finder_google_search_prompts').insert({ itp: itp.id, query });

    const shouldContinue = await runSerperQuery(query);
    if (!shouldContinue) break;
  }

  {
    const count = await countApprovedLeads(itp.id);
    console.log(`[target_finder_100] After Step 3: ${count}/${targetCount}`);
    if (count >= targetCount) return finalize(itp, user_details_id, targetCount, runId);
  }

  // ================================================================
  // STEP 4: Apollo Company Search (optional)
  // ================================================================
  if (APOLLO_COMPANY_SEARCH_ENABLED) {
    const count = await countApprovedLeads(itp.id);
    if (count < targetCount) {
      console.log('[target_finder_100] === STEP 4: Apollo Company Search ===');

      try {
        const { searchCompaniesByName } = await import('../../../../config/apollo.js');
        const terms = searchProfile.buyer_descriptions?.slice(0, 5) ?? [];

        for (const term of terms) {
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
            const sp = fillTemplate(hybridScoreTemplate, { '{{buyer_context}}': buyerContext }).replace('{{hybrid_companies}}', targetsList);
            const sr = await callClaude({ model: 'gpt-5-mini', max_completion_tokens: 256, messages: [{ role: 'user', content: sp }] });

            let score = 0, reason = '';
            try {
              const parsed = JSON.parse(sr.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
              score = parsed[0]?.score ?? 0; reason = parsed[0]?.reason ?? '';
            } catch {}

            if (score >= HIGH_SCORE_THRESHOLD) {
              await admin.from('leads').insert({ target_id: newTarget.id, itp_id: itp.id, score, score_reason: reason, approved: true });
              try {
                const enrichResult = await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true });
                await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
              } catch (err) {
                console.error('[target_finder_100] Apollo enrich error:', err.message);
              }
            }
          }

          const c = await countApprovedLeads(itp.id);
          if (c >= targetCount) break;
        }
      } catch (err) {
        console.error('[target_finder_100] Step 4 error:', err.message);
      }
    }
  }

  return finalize(itp, user_details_id, targetCount, runId);
}

async function finalize(itp, user_details_id, targetCount, runId = null) {
  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads')
    .select('id, score, approved, target_id, targets(id, title, link)')
    .eq('itp_id', itp.id);

  const finalApprovedCount = (finalLeads ?? []).filter(l => l.approved).length;
  console.log(`[target_finder_100] Final: ${finalApprovedCount} approved leads`);

  await increment(runId, { ch_companies_after_scoring: finalApprovedCount });
  await closeRun(runId, 'completed');

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
