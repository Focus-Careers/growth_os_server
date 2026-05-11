import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** All valid classification values */
export const CLASSIFICATION = {
  REAL_OPERATING_BUSINESS: 'real_operating_business',
  WHITELISTED_DIRECTORY: 'whitelisted_directory',
  NON_WHITELISTED_DIRECTORY: 'non_whitelisted_directory',
  NATIONAL_CHAIN: 'national_chain_or_franchise_corporate',
  MARKETPLACE: 'marketplace_or_classified',
  PARKED_OR_DEAD: 'parked_or_dead',
  UNCLEAR: 'unclear',
};

/** Returns true for the two classifications that should proceed downstream */
export function shouldProceed(classification) {
  return (
    classification === CLASSIFICATION.REAL_OPERATING_BUSINESS ||
    classification === CLASSIFICATION.WHITELISTED_DIRECTORY
  );
}

/**
 * Classify a scraped page to determine whether it represents a real operating business.
 * Also extracts useful metadata (registration number, postcodes, phones, named people).
 *
 * @param {object} params
 * @param {string}   params.url
 * @param {object}   params.scraped          - Output from scrapeSite()
 * @param {string[]} [params.directory_whitelist] - ITP's trusted directory domains
 *
 * @returns {Promise<{
 *   classification: string,
 *   confidence: number,
 *   reasoning: string,
 *   extracted_metadata: {
 *     registration_number: string|null,
 *     postcodes: string[],
 *     phones: string[],
 *     named_people: Array<{name: string, role: string|null}>,
 *   },
 * }>}
 */
export async function classifyLiveness({ url, scraped, directory_whitelist = [] }) {
  // Fast-path: nothing to classify
  if (!scraped || scraped.blocked || scraped.pages_scraped === 0) {
    return blocked_result('Could not fetch page — blocked or empty.');
  }

  let domain = '';
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ok */ }

  const isWhitelisted = directory_whitelist.some(
    d => domain === d || domain.endsWith('.' + d)
  );

  const prompt = await readFile(join(__dirname, 'prompts/prompt_liveness_classify.md'), 'utf-8');

  const content = [
    `URL: ${url}`,
    `Domain in ITP whitelist: ${isWhitelisted}`,
    `ITP whitelisted directories: ${directory_whitelist.length > 0 ? directory_whitelist.join(', ') : 'none'}`,
    '',
    'Page content (up to 4000 chars):',
    scraped.all_text.slice(0, 4000),
    '',
    `Emails on page: ${scraped.all_emails.join(', ') || 'none'}`,
  ].join('\n');

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 512,
      messages: [{ role: 'user', content: `${prompt}\n\n${content}` }],
    });
  } catch (err) {
    console.error(`[liveness_classifier] LLM error for ${url}:`, err.message);
    return blocked_result('LLM call failed.');
  }

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  try {
    const parsed = JSON.parse(raw);
    return {
      classification: parsed.classification ?? CLASSIFICATION.UNCLEAR,
      confidence: parsed.confidence ?? 50,
      reasoning: parsed.reasoning ?? '',
      extracted_metadata: {
        registration_number: parsed.extracted_metadata?.registration_number ?? null,
        postcodes: parsed.extracted_metadata?.postcodes ?? [],
        phones: parsed.extracted_metadata?.phones ?? [],
        named_people: parsed.extracted_metadata?.named_people ?? [],
      },
    };
  } catch {
    console.error(`[liveness_classifier] Parse error for ${url}:`, raw.slice(0, 200));
    return blocked_result('Classification response could not be parsed.');
  }
}

function blocked_result(reason) {
  return {
    classification: CLASSIFICATION.UNCLEAR,
    confidence: 0,
    reasoning: reason,
    extracted_metadata: { registration_number: null, postcodes: [], phones: [], named_people: [] },
  };
}
