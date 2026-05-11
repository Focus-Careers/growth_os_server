import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIDENCE = {
  VERIFIED_NAMED: 'verified_named',
  NAMED_NO_EMAIL: 'named_no_email',
  GENERIC_MAILBOX: 'generic_mailbox',
  WEAK_EXTRACTION: 'weak_extraction',
};

/**
 * Extract contact hypotheses from scraped website content.
 * Returns hypotheses — intermediate objects with confidence labels — not final contacts.
 * The contact_reconciler consumes these alongside Apollo and CH data.
 *
 * @param {object} params
 * @param {object} params.scraped        - Output from scrapeSite()
 * @param {string} params.domain
 * @param {string} [params.company_name]
 *
 * @returns {Promise<Array<{
 *   first_name: string|null,
 *   last_name: string|null,
 *   role: string|null,
 *   email: string|null,
 *   phone: string|null,
 *   linkedin: string|null,
 *   confidence_label: string,
 *   source_page: string|null,
 *   evidence_snippet: string|null,
 * }>>}
 */
export async function extractContactHypotheses({ scraped, domain, company_name }) {
  if (!scraped || scraped.pages_scraped === 0 || scraped.all_text.length < 200) {
    console.log(`[contact_extractor] No content to extract for ${domain}`);
    return [];
  }

  const prompt = await readFile(join(__dirname, 'prompts/prompt_contact_extract.md'), 'utf-8');

  const content = [
    `Domain: ${domain}`,
    `Company name: ${company_name ?? 'Unknown'}`,
    '',
    'Website content:',
    scraped.all_text.slice(0, 8000),
  ].join('\n');

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 1024,
      messages: [{ role: 'user', content: `${prompt}\n\n${content}` }],
    });
  } catch (err) {
    console.error(`[contact_extractor] LLM error for ${domain}:`, err.message);
    return [];
  }

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  let hypotheses;
  try {
    hypotheses = JSON.parse(raw);
    if (!Array.isArray(hypotheses)) hypotheses = [];
  } catch {
    console.error(`[contact_extractor] Parse error for ${domain}:`, raw.slice(0, 200));
    return [];
  }

  // Validate and normalise each hypothesis
  const valid = hypotheses
    .filter(h => h && typeof h === 'object')
    .map(h => ({
      first_name: h.first_name ?? null,
      last_name: h.last_name ?? null,
      role: h.role ?? null,
      email: normaliseEmail(h.email),
      phone: h.phone ?? null,
      linkedin: h.linkedin ?? null,
      confidence_label: isValidConfidence(h.confidence_label) ? h.confidence_label : CONFIDENCE.WEAK_EXTRACTION,
      source_page: h.source_page ?? null,
      evidence_snippet: h.evidence_snippet ?? null,
    }));

  console.log(`[contact_extractor] ${valid.length} hypotheses extracted for ${domain}`);
  return valid;
}

function normaliseEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  // Basic sanity check — must have @, a dot in the domain part, and no spaces
  if (!trimmed.includes('@') || trimmed.includes(' ')) return null;
  const [, domain] = trimmed.split('@');
  if (!domain || !domain.includes('.')) return null;
  return trimmed;
}

function isValidConfidence(label) {
  return Object.values(CONFIDENCE).includes(label);
}
