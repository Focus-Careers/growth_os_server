import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a search profile for an ITP.
 *
 * Stable fields (buyer_descriptions, directory_whitelist, negative_keywords,
 * company_name_keywords, min_company_age_years) are cached in itp.search_profile
 * and reused across runs. search_queries are always freshly generated so each
 * run discovers different companies. Previously used queries are loaded from
 * target_finder_google_search_prompts and passed to the LLM to avoid repetition.
 *
 * Returns: {
 *   search_queries: string[],         // always fresh
 *   directory_whitelist: string[],    // cached
 *   negative_keywords: string[],      // cached
 *   buyer_descriptions: string[],     // cached
 *   company_name_keywords: string[],  // cached
 *   min_company_age_years: number,    // cached
 *   customer_sic_codes?: string[],    // preserved from analyse_customers skill
 * }
 *
 * @param {object} params
 * @param {object} params.itp     - Full ITP record from DB
 * @param {object} params.account - Account record from DB
 * @param {boolean} [params.force] - Force regeneration of stable fields too
 */
export async function generateQueryProfile({ itp, account, force = false }) {
  const admin = getSupabaseAdmin();

  // Load all previously used queries for this ITP
  const { data: priorRows } = await admin
    .from('target_finder_google_search_prompts')
    .select('query')
    .eq('itp', itp.id)
    .order('created_at', { ascending: true });
  const prior_search_queries = (priorRows ?? []).map(r => r.query);

  // Use cached stable fields if available — only regenerate when forced or missing
  const cachedStable = (!force && itp.search_profile && isStableProfileValid(itp.search_profile))
    ? itp.search_profile
    : null;

  if (cachedStable) {
    console.log(`[query_generator] Cached stable profile found for ITP ${itp.id}; generating fresh queries (${prior_search_queries.length} prior to avoid)`);
  } else {
    console.log(`[query_generator] Generating full search profile for ITP ${itp.id}${force ? ' (forced)' : ''}`);
  }

  const prompt = await readFile(join(__dirname, 'prompts/prompt_query_generate.md'), 'utf-8');

  const context = {
    account: {
      name: account.organisation_name ?? '',
      website: account.organisation_website ?? '',
      description: account.description ?? '',
      problem_solved: account.problem_solved ?? '',
    },
    itp: {
      name: itp.name ?? '',
      summary: itp.itp_summary ?? '',
      demographics: itp.itp_demographic ?? '',
      pain_points: itp.itp_pain_points ?? '',
      buying_trigger: itp.itp_buying_trigger ?? '',
      location: itp.location ?? '',
    },
    ...(prior_search_queries.length > 0 ? { prior_search_queries } : {}),
    ...(cachedStable ? {
      existing_stable_profile: {
        buyer_descriptions:    cachedStable.buyer_descriptions,
        directory_whitelist:   cachedStable.directory_whitelist,
        negative_keywords:     cachedStable.negative_keywords,
        company_name_keywords: cachedStable.company_name_keywords,
        min_company_age_years: cachedStable.min_company_age_years,
      },
    } : {}),
  };

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5',
    max_completion_tokens: 2048,
    messages: [
      { role: 'user', content: `${prompt}\n\n${JSON.stringify(context, null, 2)}` },
    ],
  });

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    console.error('[query_generator] Failed to parse LLM response:', raw.slice(0, 300));
    throw new Error('query_generator: LLM returned unparseable response');
  }

  // Preserve customer_sic_codes — written by analyse_customers, not regenerated here
  if (itp.search_profile?.customer_sic_codes?.length) {
    profile.customer_sic_codes = itp.search_profile.customer_sic_codes;
  }

  // Persist stable fields only — search_queries are not cached so each run gets fresh ones
  const stableFields = {
    buyer_descriptions:    profile.buyer_descriptions,
    directory_whitelist:   profile.directory_whitelist,
    negative_keywords:     profile.negative_keywords,
    company_name_keywords: profile.company_name_keywords,
    min_company_age_years: profile.min_company_age_years,
    ...(profile.customer_sic_codes?.length ? { customer_sic_codes: profile.customer_sic_codes } : {}),
  };

  await admin.from('itp').update({ search_profile: stableFields }).eq('id', itp.id);

  console.log(
    `[query_generator] Done: ${profile.search_queries?.length ?? 0} fresh queries, ` +
    `${profile.directory_whitelist?.length ?? 0} directory entries`
  );

  return { ...stableFields, search_queries: profile.search_queries ?? [] };
}

/**
 * Clear the cached search profile for an ITP.
 * Must be called by itp_refiner_v2 whenever a diff is applied,
 * so the next run generates a fresh profile incorporating the refined ITP.
 */
export async function clearQueryProfileCache(itpId) {
  await getSupabaseAdmin()
    .from('itp')
    .update({ search_profile: null })
    .eq('id', itpId);
  console.log(`[query_generator] Cache cleared for ITP ${itpId} — will regenerate on next run`);
}

function isStableProfileValid(profile) {
  return (
    Array.isArray(profile.directory_whitelist) &&
    Array.isArray(profile.negative_keywords) &&
    Array.isArray(profile.buyer_descriptions)
  );
}
