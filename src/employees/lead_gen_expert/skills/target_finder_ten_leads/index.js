import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { searchCompaniesHouseForItp } from './companies_house_search.js';
import { isDomainBlocked } from './domain_resolver.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';
import { buildSearchProfile } from './build_search_profile.js';
import { shouldSkipCompany } from './company_filter.js';
import { searchCompanies as searchCH, getCompanyProfile } from '../../../../config/companies_house.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGH_SCORE_THRESHOLD = 70;
const TARGET_HIGH_SCORE_COUNT = 10;
const MAX_SERPER_ITERATIONS = 20;
const CH_BATCH_SIZE = 40;
const APOLLO_COMPANY_SEARCH_ENABLED = process.env.APOLLO_COMPANY_SEARCH_ENABLED === 'true';

async function callClaude({ model, max_completion_tokens, system, messages, ...rest }, retries = 3) {
  const openaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  const params = { model, max_completion_tokens: max_completion_tokens, messages: openaiMessages, ...rest };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await getOpenAI().chat.completions.create(params);
      // Wrap response to match Anthropic shape used throughout this file
      return { content: [{ text: res.choices[0].message.content }] };
    } catch (err) {
      if (err?.status === 429 && attempt < retries - 1) {
        console.log(`[target_finder] Rate limited, waiting 60s...`);
        await new Promise(r => setTimeout(r, 60000));
      } else throw err;
    }
  }
}

async function countHighScoreLeads(itpId) {
  const { data } = await getSupabaseAdmin()
    .from('leads').select('id, score, rejected').eq('itp_id', itpId);
  return (data ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
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

function progressMessage(text, percent) {
  return `${text} ${percent}%`;
}

async function sendProgress(user_details_id, text, percent) {
  await broadcastSkillStatus(user_details_id, {
    employee: 'lead_gen_expert', skill: 'target_finder_ten_leads',
    status: 'running', message: progressMessage(text, percent), persist: false,
  });
}

/**
 * Build buyer context string for scoring prompts from the search profile.
 */
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
 * Score a batch of structured companies against the ITP.
 */
async function scoreStructuredBatch(companies, fillTemplate, structuredScoreTemplate, buyerContext) {
  const structuredList = companies.map((c, i) =>
    `[${i}] Company: "${c.companyName}" (${c.domain ?? 'no website'})\n` +
    `    Industry (SIC): ${c.sicDescription}\n` +
    `    Location: ${c.location ?? 'Unknown'}\n` +
    `    Founded: ${c.dateOfCreation ?? 'Unknown'}\n` +
    `    Officers: ${c.officers?.map(o => `${o.first_name ?? ''} ${o.last_name ?? ''} (${o.role ?? 'unknown role'})`).join(', ') || 'None listed'}\n` +
    `    Company Number: ${c.companyNumber}`
  ).join('\n\n');

  const scorePrompt = fillTemplate(structuredScoreTemplate, {
    '{{structured_companies}}': structuredList,
    '{{buyer_context}}': buyerContext,
  });

  const scoreResponse = await callClaude({
    model: 'gpt-5-mini', max_completion_tokens: 1024,
    messages: [{ role: 'user', content: scorePrompt }],
  });

  try {
    const raw = scoreResponse.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(raw);
  } catch {
    console.error('[target_finder] Failed to parse scores');
    return [];
  }
}

/**
 * Create a target + lead + officers from a scored CH company, then enrich.
 */
async function createLeadFromCH(chCompany, score, reason, itp, accountId, user_details_id, dedupSets) {
  const admin = getSupabaseAdmin();

  const { data: newTarget, error } = await admin.from('targets').insert({
    domain: chCompany.domain, title: chCompany.companyName, link: chCompany.link,
    companies_house_number: chCompany.companyNumber,
    company_location: chCompany.location, industry: chCompany.sicDescription,
  }).select('id').single();

  if (error) { console.error('[target_finder] Target insert error:', error); return; }

  const targetId = newTarget.id;
  if (chCompany.domain) dedupSets.existingDomains.add(chCompany.domain);
  if (chCompany.companyNumber) dedupSets.existingCHNumbers.add(chCompany.companyNumber);

  await admin.from('leads').insert({
    target_id: targetId, itp_id: itp.id, score, score_reason: reason ?? null,
  });

  // Save officers as contacts
  for (const officer of (chCompany.officers ?? [])) {
    if (!officer.first_name && !officer.last_name) continue;
    await admin.from('contacts').insert({
      target_id: targetId, account_id: accountId,
      first_name: officer.first_name, last_name: officer.last_name,
      role: officer.role, email: null, source: 'companies_house',
    });
  }

  // Enrich
  if (chCompany.domain) {
    try {
      await runEnrichTarget({ target_id: targetId, user_details_id, silent: true });
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[target_finder] Enrich error for ${chCompany.companyName}:`, err.message);
    }
  }
}

// ====================================================================
// MAIN SKILL
// ====================================================================

export async function executeSkill({ user_details_id, itp_id }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();

  // Load ITP
  let itpQuery = admin.from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();

  if (!itp) throw new Error('No ITP found for account');

  const initialHighScoreCount = await countHighScoreLeads(itp.id);
  const dynamicTarget = initialHighScoreCount + TARGET_HIGH_SCORE_COUNT;
  console.log(`[target_finder] Starting with ${initialHighScoreCount} existing, aiming for ${dynamicTarget}`);

  // Load account
  const { data: account } = await admin
    .from('account').select('organisation_name, organisation_website, description, problem_solved')
    .eq('id', itp.account_id).single();

  // Load customer analysis (if customers exist)
  const { data: customers } = await admin
    .from('customers').select('organisation_name, organisation_website')
    .eq('account_id', userDetails.account_id);

  let customerAnalysis = null;
  if (customers?.length > 0) {
    // Extract SIC codes from search profile if it was built during customer analysis
    // The analyse_customers skill would have refined the ITP already
    customerAnalysis = { customerSicCodes: [], customerLocations: [] };
    // Customer SIC patterns come from the search profile (built from customer analysis)
  }

  // ── Build Search Profile ───────────────────────────────────────────
  await sendProgress(user_details_id, 'Belfort is building search profile...', 2);
  const searchProfile = await buildSearchProfile(itp, account, customerAnalysis);
  const buyerContext = buildBuyerContext(searchProfile);

  // Load prompt templates
  const structuredScoreTemplate = await readFile(join(__dirname, 'prompt_score_structured.md'), 'utf-8');
  const hybridScoreTemplate = await readFile(join(__dirname, 'prompt_score_hybrid.md'), 'utf-8');
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
    console.log('[target_finder] === STEP 1: Customer Lookalike ===');
    await sendProgress(user_details_id, 'Belfort is searching for companies matching your customers...', 5);

    try {
      // Search CH with customer SIC codes (not the broad approved codes)
      const chResults = await searchCompaniesHouseForItp({
        itp: { ...itp, sic_codes: searchProfile.customer_sic_codes },
        existingDomains: dedupSets.existingDomains,
        existingCHNumbers: dedupSets.existingCHNumbers,
        customerDomains: dedupSets.customerDomains,
        onProgress: (processed, total) => {
          const percent = 5 + Math.round((processed / total) * 25);
          sendProgress(user_details_id, 'Belfort is searching for companies matching your customers...', percent);
        },
      });

      // Pre-filter
      const filtered = chResults.filter(c => !shouldSkipCompany(c, searchProfile));
      console.log(`[target_finder] Step 1: ${chResults.length} found, ${filtered.length} after pre-filter`);

      if (filtered.length > 0) {
        // Score in batches
        const allScored = [];
        for (let i = 0; i < filtered.length; i += CH_BATCH_SIZE) {
          const batch = filtered.slice(i, i + CH_BATCH_SIZE);
          await sendProgress(user_details_id, 'Belfort is scoring companies...', 30 + Math.round((i / filtered.length) * 8));
          const scores = await scoreStructuredBatch(batch, fillTemplate, structuredScoreTemplate, buyerContext);
          for (const item of scores) {
            if (batch[item.index]) allScored.push({ company: batch[item.index], score: item.score, reason: item.reason });
          }
        }

        // Create leads for high scorers (up to target)
        let created = 0;
        for (const { company, score, reason } of allScored) {
          if (initialHighScoreCount + created >= dynamicTarget) break;
          if ((score ?? 0) < HIGH_SCORE_THRESHOLD) continue;
          await createLeadFromCH(company, score, reason, itp, userDetails.account_id, user_details_id, dedupSets);
          created++;
          await sendProgress(user_details_id, 'Belfort is enriching lead data...', 38 + Math.round((created / TARGET_HIGH_SCORE_COUNT) * 2));
        }

        const count = await countHighScoreLeads(itp.id);
        console.log(`[target_finder] After Step 1: ${count}/${dynamicTarget}`);
        if (count >= dynamicTarget) return finalize(itp, user_details_id);
      }
    } catch (err) {
      console.error('[target_finder] Step 1 error:', err.message);
    }
  }

  // ================================================================
  // STEP 2: Targeted Google Search (good quality, free)
  // ================================================================
  console.log('[target_finder] === STEP 2: Targeted Google Search ===');
  await sendProgress(user_details_id, 'Belfort is searching Google for matches...', 42);

  const queries = searchProfile.search_queries ?? [];
  const scorePromptBase = fillTemplate(hybridScoreTemplate, { '{{buyer_context}}': buyerContext });

  for (let qi = 0; qi < Math.min(queries.length, MAX_SERPER_ITERATIONS); qi++) {
    const count = await countHighScoreLeads(itp.id);
    if (count >= dynamicTarget) break;

    const query = queries[qi];
    console.log(`[target_finder] Google query ${qi + 1}/${queries.length}: ${query}`);
    const percent = 42 + Math.round((qi / queries.length) * 25);
    await sendProgress(user_details_id, 'Belfort is searching Google for matches...', percent);

    try {
      const serperRes = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 10, ...(itp.location ? { location: itp.location } : {}), hl: 'en' }),
      });
      const serperData = await serperRes.json();
      if (!serperRes.ok) { console.error('[target_finder] Serper error:', JSON.stringify(serperData)); continue; }

      const organic = serperData.organic ?? [];
      const newResults = [];

      for (const result of organic) {
        if (!result.link) continue;
        let domain;
        try { domain = new URL(result.link).hostname.replace(/^www\./, ''); } catch { continue; }
        if (dedupSets.customerDomains.has(result.link.toLowerCase())) continue;
        if (isDomainBlocked(domain)) continue;
        if (dedupSets.existingDomains.has(domain)) continue;
        newResults.push({ ...result, _domain: domain });
      }

      if (newResults.length === 0) continue;

      // Cross-reference with CH for structured data
      const hybridList = [];
      for (const result of newResults) {
        let chData = null;
        // Try to find on CH by company name (from page title)
        const companyName = result.title?.replace(/\s*[-|–].*$/, '').trim();
        if (companyName) {
          try {
            const chSearch = await searchCH({ companyName, size: 3 });
            const match = (chSearch.items ?? []).find(item => {
              // Simple match: domain or name similarity
              return item.company_name?.toUpperCase().includes(companyName.toUpperCase().slice(0, 20));
            });
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

        hybridList.push({
          index: hybridList.length,
          title: result.title, link: result.link, snippet: result.snippet,
          domain: result._domain, chData,
        });
      }

      // Score hybrid results
      const targetsList = hybridList.map((h, i) => {
        let entry = `[${i}] Title: ${h.title ?? 'N/A'}\n    URL: ${h.link}\n    Snippet: ${h.snippet ?? ''}`;
        if (h.chData) {
          entry += `\n    [Companies House verified] SIC: ${h.chData.sicCodes.join(', ')} | Founded: ${h.chData.dateOfCreation ?? 'Unknown'} | Location: ${h.chData.location ?? 'Unknown'}`;
        }
        return entry;
      }).join('\n\n');

      const scorePrompt = scorePromptBase.replace('{{hybrid_companies}}', targetsList);
      const scoreRes = await callClaude({ model: 'gpt-5-mini', max_completion_tokens: 1024, messages: [{ role: 'user', content: scorePrompt }] });

      let scores = [];
      try {
        scores = JSON.parse(scoreRes.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      } catch { console.error('[target_finder] Failed to parse Google scores'); continue; }

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
          target_id: newTarget.id, itp_id: itp.id, score: item.score, score_reason: item.reason,
        });

        try {
          await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true });
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) { console.error('[target_finder] Google enrich error:', err.message); }
      }
    } catch (err) {
      console.error('[target_finder] Step 2 query error:', err.message);
    }
  }

  {
    const count = await countHighScoreLeads(itp.id);
    console.log(`[target_finder] After Step 2: ${count}/${dynamicTarget}`);
    if (count >= dynamicTarget) return finalize(itp, user_details_id);
  }

  // ================================================================
  // STEP 3: CH Broad Search (backfill)
  // ================================================================
  console.log('[target_finder] === STEP 3: CH Broad Search ===');
  await sendProgress(user_details_id, 'Belfort is searching Companies House...', 70);

  try {
    const chResults = await searchCompaniesHouseForItp({
      itp,
      existingDomains: dedupSets.existingDomains,
      existingCHNumbers: dedupSets.existingCHNumbers,
      customerDomains: dedupSets.customerDomains,
      onProgress: (processed, total) => {
        const percent = 70 + Math.round((processed / total) * 15);
        sendProgress(user_details_id, 'Belfort is searching Companies House...', percent);
      },
    });

    // Aggressive pre-filtering
    const filtered = chResults.filter(c => {
      const reason = shouldSkipCompany(c, searchProfile);
      if (reason) console.log(`[target_finder] Pre-filter skip: ${c.companyName} — ${reason}`);
      return !reason;
    });
    console.log(`[target_finder] Step 3: ${chResults.length} found, ${filtered.length} after pre-filter`);

    if (filtered.length > 0) {
      // Calculate how many more we need at the point Step 3 starts
      const countBeforeStep3 = await countHighScoreLeads(itp.id);
      const neededInStep3 = Math.max(0, dynamicTarget - countBeforeStep3);
      let created = 0;

      for (let i = 0; i < filtered.length; i += CH_BATCH_SIZE) {
        if (created >= neededInStep3) break;
        const batch = filtered.slice(i, i + CH_BATCH_SIZE);
        await sendProgress(user_details_id, 'Belfort is scoring companies...', 85 + Math.round((i / filtered.length) * 5));
        const scores = await scoreStructuredBatch(batch, fillTemplate, structuredScoreTemplate, buyerContext);

        for (const item of scores) {
          if (created >= neededInStep3) break;
          const company = batch[item.index];
          if (!company || (item.score ?? 0) < HIGH_SCORE_THRESHOLD) continue;
          await createLeadFromCH(company, item.score, item.reason, itp, userDetails.account_id, user_details_id, dedupSets);
          created++;
        }

        const count = await countHighScoreLeads(itp.id);
        if (count >= dynamicTarget) break;
      }
    }
  } catch (err) {
    console.error('[target_finder] Step 3 error:', err.message);
  }

  // ================================================================
  // STEP 4: Apollo Company Search (optional)
  // ================================================================
  if (APOLLO_COMPANY_SEARCH_ENABLED) {
    const count = await countHighScoreLeads(itp.id);
    if (count < dynamicTarget) {
      console.log('[target_finder] === STEP 4: Apollo Company Search ===');
      await sendProgress(user_details_id, 'Belfort is searching Apollo...', 92);

      try {
        const { searchCompaniesByName } = await import('../../../../config/apollo.js');
        const terms = searchProfile.buyer_descriptions?.slice(0, 3) ?? [];

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

            // Quick score
            const targetsList = `[0] Title: ${org.name ?? 'N/A'}\nURL: https://${domain}\nSnippet: ${org.short_description ?? ''}`;
            const sp = fillTemplate(hybridScoreTemplate, { '{{buyer_context}}': buyerContext }).replace('{{hybrid_companies}}', targetsList);
            const sr = await callClaude({ model: 'gpt-5-mini', max_completion_tokens: 256, messages: [{ role: 'user', content: sp }] });

            let score = 0, reason = '';
            try {
              const parsed = JSON.parse(sr.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
              score = parsed[0]?.score ?? 0; reason = parsed[0]?.reason ?? '';
            } catch {}

            if (score >= HIGH_SCORE_THRESHOLD) {
              await admin.from('leads').insert({ target_id: newTarget.id, itp_id: itp.id, score, score_reason: reason });
              try { await runEnrichTarget({ target_id: newTarget.id, user_details_id, silent: true }); } catch {}
            }
          }
          const c = await countHighScoreLeads(itp.id);
          if (c >= dynamicTarget) break;
        }
      } catch (err) {
        console.error('[target_finder] Step 4 error:', err.message);
      }
    }
  }

  return finalize(itp, user_details_id);
}

async function finalize(itp, user_details_id) {
  await sendProgress(user_details_id, 'Belfort is finalising results...', 95);

  const { data: finalLeads } = await getSupabaseAdmin()
    .from('leads').select('id, score, rejected, target_id, targets(id, title, link)')
    .eq('itp_id', itp.id);

  const highScoreTotal = (finalLeads ?? []).filter(l => (l.score ?? 0) >= HIGH_SCORE_THRESHOLD && !l.rejected).length;
  console.log(`[target_finder] Final: ${highScoreTotal} high-score leads`);

  await processSkillOutput({
    employee: 'lead_gen_expert', skill_name: 'target_finder_ten_leads', user_details_id,
    output: { itp_id: itp.id, high_score_count: highScoreTotal, total_targets: (finalLeads ?? []).length },
  });

  return { user_details_id, itp_id: itp.id, leads: finalLeads ?? [] };
}
