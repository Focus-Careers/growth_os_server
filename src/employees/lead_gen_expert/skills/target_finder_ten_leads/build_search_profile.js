import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build a search profile for target finding. Combines ITP, account info,
 * and customer analysis into a structured search strategy.
 * Cached on the ITP's search_profile JSONB column.
 *
 * @param {object} itp - The ITP record (with sic_codes)
 * @param {object} account - The account record
 * @param {{ customerSicCodes?: string[], customerLocations?: string[] }} customerAnalysis - Optional
 * @returns {Promise<object>} The search profile
 */
export async function buildSearchProfile(itp, account, customerAnalysis = null) {
  // Check cache
  if (itp.search_profile && typeof itp.search_profile === 'object' && itp.search_profile.buyer_descriptions) {
    console.log(`[search_profile] Using cached profile for ITP ${itp.id}`);
    return itp.search_profile;
  }

  console.log(`[search_profile] Building profile for ITP ${itp.id}`);

  const prompt = await readFile(join(__dirname, 'prompt_search_profile.md'), 'utf-8');

  const context = [
    '# Company Information',
    `Company name: ${account?.organisation_name ?? 'Unknown'}`,
    `Description: ${account?.description ?? 'Not provided'}`,
    `Problem solved: ${account?.problem_solved ?? 'Not provided'}`,
    '',
    '# Ideal Target Profile',
    `Name: ${itp.name ?? ''}`,
    `Summary: ${itp.itp_summary ?? ''}`,
    `Demographics: ${itp.itp_demographic ?? ''}`,
    `Pain Points: ${itp.itp_pain_points ?? ''}`,
    `Buying Triggers: ${itp.itp_buying_trigger ?? ''}`,
    `Location: ${itp.location ?? 'United Kingdom'}`,
    `Approved SIC codes: ${(itp.sic_codes ?? []).join(', ')}`,
  ];

  if (customerAnalysis) {
    context.push('');
    context.push('# Existing Customer Analysis');
    if (customerAnalysis.customerSicCodes?.length) {
      context.push(`Customer SIC codes (from real customers): ${customerAnalysis.customerSicCodes.join(', ')}`);
    }
    if (customerAnalysis.customerLocations?.length) {
      context.push(`Customer locations: ${customerAnalysis.customerLocations.join(', ')}`);
    }
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: prompt,
    messages: [{ role: 'user', content: context.join('\n') }],
  });

  const text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let profile;
  try {
    profile = JSON.parse(text);
  } catch {
    console.error('[search_profile] Failed to parse profile:', text.slice(0, 200));
    // Return a minimal profile so the pipeline can continue
    profile = {
      buyer_descriptions: [],
      company_name_keywords: [],
      company_name_negatives: ['investments', 'holdings', 'capital'],
      search_queries: [],
      min_company_age_years: 2,
    };
  }

  // Merge in data that Claude doesn't generate
  profile.target_sic_codes = itp.sic_codes ?? [];
  profile.customer_sic_codes = customerAnalysis?.customerSicCodes ?? [];
  profile.target_location = itp.location ?? 'United Kingdom';

  // Cache to DB
  await getSupabaseAdmin().from('itp').update({ search_profile: profile }).eq('id', itp.id);
  console.log(`[search_profile] Built and cached profile for ITP ${itp.id}: ${profile.buyer_descriptions?.length ?? 0} buyer types, ${profile.search_queries?.length ?? 0} queries`);

  return profile;
}
