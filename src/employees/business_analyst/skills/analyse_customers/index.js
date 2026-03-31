import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { searchCompanies, getCompanyProfile } from '../../../../config/companies_house.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

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

  console.log(`[analyse_customers] Analysing ${customers.length} customers for account ${userDetails.account_id}`);

  // Look up each customer on Companies House
  const customerProfiles = [];
  for (const customer of customers) {
    const name = customer.organisation_name;
    if (!name) continue;

    try {
      // Search CH by company name
      const searchResult = await searchCompanies({ companyName: name, size: 5 });
      const items = searchResult.items ?? [];

      if (items.length > 0) {
        const best = items[0];
        const profile = await getCompanyProfile(best.company_number);

        if (profile) {
          customerProfiles.push({
            name,
            company_number: best.company_number,
            sic_codes: profile.sic_codes ?? [],
            date_of_creation: profile.date_of_creation ?? null,
            company_type: profile.type ?? null,
            location: [
              profile.registered_office_address?.locality,
              profile.registered_office_address?.region,
            ].filter(Boolean).join(', ') || null,
          });
          console.log(`[analyse_customers] ${name} → CH ${best.company_number} | SIC: ${(profile.sic_codes ?? []).join(', ')}`);
        }
      } else {
        console.log(`[analyse_customers] ${name} → not found on CH`);
      }
    } catch (err) {
      console.error(`[analyse_customers] Error looking up ${name}:`, err.message);
    }
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
  const locations = [];
  const ages = [];
  const now = new Date().getFullYear();

  for (const p of customerProfiles) {
    for (const sic of p.sic_codes) {
      sicCodeCounts[sic] = (sicCodeCounts[sic] ?? 0) + 1;
    }
    if (p.location) locations.push(p.location);
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
    `Customers analysed: ${customerProfiles.length} of ${customers.length}`,
    `Most common SIC codes: ${topSicCodes.join(', ')}`,
    `Customer locations: ${[...new Set(locations)].join('; ')}`,
    avgAge ? `Average company age: ${avgAge} years` : null,
  ].filter(Boolean).join('\n');

  console.log(`[analyse_customers] Analysis:\n${analysis}`);

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
      `- ${p.name}: SIC ${p.sic_codes.join(', ')} | Location: ${p.location ?? 'Unknown'} | Founded: ${p.date_of_creation ?? 'Unknown'} | Type: ${p.company_type ?? 'Unknown'}`
    ),
  ].join('\n');

  const response = await getAnthropic().messages.create({
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
