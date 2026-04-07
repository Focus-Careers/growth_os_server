import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { searchCompanies, getCompanyProfile } from '../../../../config/companies_house.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';

const MAX_CUSTOMERS_TO_ANALYSE = 150;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Analyse existing customers via Companies House and save a customer_profile
 * to the account table. define_itp will read this when building the ITP.
 */
export async function executeSkill({ user_details_id }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();

  if (!userDetails?.account_id) {
    return processSkillOutput({
      employee: 'business_analyst', skill_name: 'analyse_customers', user_details_id,
      output: { skipped: true, reason: 'no_account' },
    });
  }

  // Fetch customers
  const { data: customers } = await admin
    .from('customers').select('*').eq('account_id', userDetails.account_id);

  if (!customers?.length) {
    console.log('[analyse_customers] No customers found, skipping');
    return processSkillOutput({
      employee: 'business_analyst', skill_name: 'analyse_customers', user_details_id,
      output: { skipped: true, reason: 'no_customers' },
    });
  }

  console.log(`[analyse_customers] ${customers.length} customers in DB for account ${userDetails.account_id}`);

  // Returns a simple overlap score between two strings (0–1)
  function nameSimilarity(a, b) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const wordsA = new Set(norm(a).split(/\s+/).filter(Boolean));
    const wordsB = norm(b).split(/\s+/).filter(Boolean);
    if (!wordsA.size || !wordsB.length) return 0;
    const matches = wordsB.filter(w => wordsA.has(w)).length;
    return matches / Math.max(wordsA.size, wordsB.length);
  }

  async function sendProgress(text, percent) {
    await broadcastSkillStatus(user_details_id, {
      employee: 'business_analyst', skill: 'analyse_customers',
      status: 'running', message: `${text} ${percent}%`, persist: false,
    });
  }

  // Deduplicate by normalised name, then shuffle and sample
  const seen = new Set();
  const deduplicated = customers.filter(c => {
    if (!c.organisation_name) return false;
    const key = c.organisation_name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Fisher-Yates shuffle
  for (let i = deduplicated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deduplicated[i], deduplicated[j]] = [deduplicated[j], deduplicated[i]];
  }

  const sample = deduplicated.slice(0, MAX_CUSTOMERS_TO_ANALYSE);
  console.log(`[analyse_customers] Deduplicated: ${deduplicated.length}, sampling: ${sample.length}`);

  await sendProgress('Warren is looking up your customers...', 5);

  async function processCustomer(customer) {
    const name = customer.organisation_name;
    try {
      let items = [];

      // Prefer domain-based search if website available (more unique than name)
      if (customer.organisation_website) {
        let domain;
        try {
          const url = customer.organisation_website.startsWith('http')
            ? customer.organisation_website
            : `https://${customer.organisation_website}`;
          domain = new URL(url).hostname.replace(/^www\./, '');
        } catch {}

        if (domain) {
          const domainResult = await searchCompanies({ companyName: domain.split('.')[0], size: 5 });
          items = domainResult.items ?? [];
        }
      }

      // Fall back to name search
      if (items.length === 0) {
        const nameResult = await searchCompanies({ companyName: name, size: 5 });
        items = nameResult.items ?? [];
      }

      if (items.length === 0) {
        console.log(`[analyse_customers] ${name} → not found on CH`);
        return null;
      }

      // Pick the best CH match using name similarity (prefer active companies)
      let bestItem = items[0];
      if (items.length > 1) {
        const scored = items.map(it => ({
          item: it,
          score: nameSimilarity(name, it.company_name ?? '') + (it.company_status === 'active' ? 0.1 : 0),
        }));
        scored.sort((a, b) => b.score - a.score);
        if (scored[0].score === 0) {
          console.log(`[analyse_customers] ${name} → no good CH match found`);
          return null;
        }
        bestItem = scored[0].item;
      }

      const profile = await getCompanyProfile(bestItem.company_number);
      if (profile) {
        console.log(`[analyse_customers] ${name} → CH ${bestItem.company_number} | SIC: ${(profile.sic_codes ?? []).join(', ')}`);
        return {
          name,
          company_number: bestItem.company_number,
          sic_codes: profile.sic_codes ?? [],
          date_of_creation: profile.date_of_creation ?? null,
          company_type: profile.type ?? null,
        };
      }
    } catch (err) {
      console.error(`[analyse_customers] Error looking up ${name}:`, err.message);
    }
    return null;
  }

  // Process in parallel chunks of 10
  const CONCURRENCY = 10;
  const customerProfiles = [];
  for (let i = 0; i < sample.length; i += CONCURRENCY) {
    const chunk = sample.slice(i, i + CONCURRENCY);
    const percent = 5 + Math.round((i / sample.length) * 80);
    await sendProgress('Warren is looking up your customers...', percent);
    const results = await Promise.all(chunk.map(processCustomer));
    customerProfiles.push(...results.filter(Boolean));
  }

  if (customerProfiles.length === 0) {
    console.log('[analyse_customers] No customers found on Companies House');
    return processSkillOutput({
      employee: 'business_analyst', skill_name: 'analyse_customers', user_details_id,
      output: { skipped: true, reason: 'no_ch_matches' },
    });
  }

  // Aggregate patterns
  const sicCodeCounts = {};
  const ages = [];
  const now = new Date().getFullYear();

  for (const p of customerProfiles) {
    for (const sic of p.sic_codes) {
      sicCodeCounts[sic] = (sicCodeCounts[sic] ?? 0) + 1;
    }
    if (p.date_of_creation) {
      const year = parseInt(p.date_of_creation.split('-')[0]);
      if (!isNaN(year)) ages.push(now - year);
    }
  }

  const topSicCodes = Object.entries(sicCodeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));

  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;

  const customer_profile = {
    top_sic_codes: topSicCodes,
    avg_company_age: avgAge,
    matched_count: customerProfiles.length,
    sampled_count: sample.length,
  };

  console.log(`[analyse_customers] Profile built: ${customerProfiles.length} matched, top SIC: ${topSicCodes.slice(0, 3).map(s => s.code).join(', ')}`);

  // Save customer profile to account so define_itp can use it
  await admin
    .from('account')
    .update({ customer_profile })
    .eq('id', userDetails.account_id);

  await processSkillOutput({
    employee: 'business_analyst',
    skill_name: 'analyse_customers',
    user_details_id,
    output: { customer_profile, account_id: userDetails.account_id },
  });

  return { user_details_id, customer_profile };
}
