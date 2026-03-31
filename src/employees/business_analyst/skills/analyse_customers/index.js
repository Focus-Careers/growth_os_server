import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { searchCompanies, getCompanyProfile } from '../../../../config/companies_house.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';

const MAX_CUSTOMERS_TO_ANALYSE = 150;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Analyse existing customers via Companies House and refine the ITP.
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

  // Fetch the most recent ITP for this account
  const { data: itp } = await admin
    .from('itp').select('*').eq('account_id', userDetails.account_id)
    .order('created_at', { ascending: false }).limit(1).single();

  if (!itp) {
    console.log('[analyse_customers] No ITP found, skipping');
    return processSkillOutput({
      employee: 'business_analyst', skill_name: 'analyse_customers', user_details_id,
      output: { skipped: true, reason: 'no_itp' },
    });
  }

  console.log(`[analyse_customers] ${customers.length} customers in DB for account ${userDetails.account_id}`);

  const anthropic = getAnthropic();

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

      // Use Claude Haiku to pick the best CH match
      let bestItem = items[0];
      if (items.length > 1) {
        const candidates = items.map((it, idx) =>
          `[${idx}] ${it.company_name} (${it.company_number}) — status: ${it.company_status ?? 'unknown'}`
        ).join('\n');

        const matchRes = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{
            role: 'user',
            content: `Which of these Companies House results best matches the customer named "${name}"${customer.organisation_website ? ` (website: ${customer.organisation_website})` : ''}?\n\n${candidates}\n\nRespond with only the index number (0, 1, 2...), or "none" if none are a good match.`,
          }],
        });

        const pick = matchRes.content[0].text.trim().toLowerCase();
        if (pick === 'none') {
          console.log(`[analyse_customers] ${name} → Claude found no good CH match`);
          return null;
        }
        const idx = parseInt(pick);
        if (!isNaN(idx) && items[idx]) bestItem = items[idx];
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
      output: { skipped: true, reason: 'no_ch_matches', itp_id: itp.id },
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
    .map(([code, count]) => `${code} (${count} customers)`);

  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;

  const analysis = [
    `Customers matched: ${customerProfiles.length} of ${sample.length} sampled (${customers.length} total)`,
    `Most common SIC codes: ${topSicCodes.join(', ')}`,
    avgAge ? `Average company age: ${avgAge} years` : null,
  ].filter(Boolean).join('\n');

  console.log(`[analyse_customers] Analysis:\n${analysis}`);

  await sendProgress('Warren is refining your target profile...', 90);

  // Call Claude to refine the ITP
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  const context = [
    '# Current ITP',
    `Name: ${itp.name ?? ''}`,
    `Summary: ${itp.itp_summary ?? ''}`,
    `Demographics: ${itp.itp_demographic ?? ''}`,
    `Pain Points: ${itp.itp_pain_points ?? ''}`,
    `Buying Trigger: ${itp.itp_buying_trigger ?? ''}`,
    `Location: ${itp.location ?? ''}`,
    '',
    '# Customer Analysis',
    analysis,
    '',
    '# Individual Customer Profiles',
    ...customerProfiles.map(p =>
      `- ${p.name}: SIC ${p.sic_codes.join(', ')} | Founded: ${p.date_of_creation ?? 'Unknown'} | Type: ${p.company_type ?? 'Unknown'}`
    ),
  ].join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: prompt,
    messages: [{ role: 'user', content: context }],
  });

  const text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let refined;
  try {
    refined = JSON.parse(text);
  } catch {
    console.error('[analyse_customers] Failed to parse refined ITP:', text);
    refined = {};
  }

  await processSkillOutput({
    employee: 'business_analyst',
    skill_name: 'analyse_customers',
    user_details_id,
    output: { ...refined, itp_id: itp.id, customer_count: customerProfiles.length },
  });

  return { user_details_id, refined, itp_id: itp.id };
}
