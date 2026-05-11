import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TIER = {
  A: 'A',    // ≥ 85
  B: 'B',    // 70–84
  C: 'C',    // 55–69
  REJECT: 'reject', // < 55
};

export function scoreToTier(score) {
  if (score >= 85) return TIER.A;
  if (score >= 70) return TIER.B;
  if (score >= 55) return TIER.C;
  return TIER.REJECT;
}

/**
 * Score a single candidate against the ITP using the full evidence bundle.
 *
 * @param {object} params
 * @param {object} params.itp                     - ITP record
 * @param {object} params.account                 - Account record
 * @param {object} params.evidence                - Evidence bundle for this candidate
 * @param {string} [params.evidence.company_name]
 * @param {string} [params.evidence.domain]
 * @param {string} [params.evidence.website_summary]     - Scraped+classified website summary
 * @param {object} [params.evidence.ch_data]             - CH record if matched
 * @param {string} [params.evidence.ch_match_confidence] - 'confirmed'|'probable'|'unmatched'
 * @param {Array}  [params.evidence.contact_hypotheses]  - Extracted contacts from website
 * @param {string} [params.evidence.discovery_source]    - How this candidate was found
 * @param {boolean}[params.evidence.directory_only]      - No own website; from directory listing only
 * @param {Array}  [params.confirmed_positives]          - Up to 5 approved leads for few-shot context
 *
 * @returns {Promise<{score: number, tier: string, reasoning: string, signals_for: string[], signals_against: string[]}>}
 */
export async function scoreCandidate({ itp, account, evidence, confirmed_positives = [] }) {
  const prompt = await readFile(join(__dirname, 'prompts/prompt_itp_score.md'), 'utf-8');

  // Build the candidate block
  const candidateLines = [
    `Company name: ${evidence.company_name ?? 'Unknown'}`,
    `Domain: ${evidence.domain ?? 'none'}`,
  ];

  if (evidence.website_summary) {
    candidateLines.push(`Website summary: ${evidence.website_summary.slice(0, 800)}`);
  }

  if (evidence.ch_data) {
    const ch = evidence.ch_data;
    const addr = ch.registered_office_address ?? {};
    candidateLines.push([
      `Companies House: ${ch.company_name ?? ''} (${ch.company_number ?? ''})`,
      `  Status: ${ch.company_status ?? 'unknown'}`,
      `  SIC codes: ${(ch.sic_codes ?? []).join(', ') || 'none'}`,
      `  Incorporated: ${ch.date_of_creation ?? 'unknown'}`,
      `  Location: ${[addr.locality, addr.region, addr.country].filter(Boolean).join(', ')}`,
      `  Match confidence: ${evidence.ch_match_confidence ?? 'unmatched'}`,
    ].join('\n'));
  }

  if (evidence.directory_only) {
    candidateLines.push('Note: directory-only candidate — no own website. Apply confidence penalty.');
  }

  // Few-shot confirmed positives block
  let few_shot_section = '';
  if (confirmed_positives.length > 0) {
    const examples = confirmed_positives.slice(0, 5).map((p, i) =>
      `Example ${i + 1}: ${p.title ?? p.domain ?? 'Unknown'}\n` +
      `  Why approved: ${p.score_reason ?? 'No reason recorded'}`
    ).join('\n\n');
    few_shot_section = `# Confirmed positive examples (use for calibration)\n\n${examples}`;
  }

  const buyer_context = buildBuyerContext(itp);

  // Fill template
  const filled = prompt
    .replace('{{account_name}}', account.organisation_name ?? '')
    .replace('{{account_website}}', account.organisation_website ?? '')
    .replace('{{account_description}}', account.description ?? '')
    .replace('{{account_problem_solved}}', account.problem_solved ?? '')
    .replace('{{itp_summary}}', itp.itp_summary ?? '')
    .replace('{{itp_demographic}}', itp.itp_demographic ?? '')
    .replace('{{itp_pain_points}}', itp.itp_pain_points ?? '')
    .replace('{{itp_buying_trigger}}', itp.itp_buying_trigger ?? '')
    .replace('{{buyer_context}}', buyer_context)
    .replace('{{few_shot_section}}', few_shot_section)
    .replace('{{candidate}}', candidateLines.join('\n'));

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 512,
      messages: [{ role: 'user', content: filled }],
    });
  } catch (err) {
    console.error(`[itp_scorer] LLM error for ${evidence.company_name}:`, err.message);
    return { score: 0, tier: TIER.REJECT, reasoning: 'Scoring failed.', signals_for: [], signals_against: [] };
  }

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  try {
    const parsed = JSON.parse(raw);
    const score = Math.max(0, Math.min(100, parsed.score ?? 0));
    return {
      score,
      tier: scoreToTier(score),
      reasoning: parsed.reasoning ?? '',
      signals_for: parsed.signals_for ?? [],
      signals_against: parsed.signals_against ?? [],
    };
  } catch {
    console.error(`[itp_scorer] Parse error for ${evidence.company_name}:`, raw.slice(0, 200));
    return { score: 0, tier: TIER.REJECT, reasoning: 'Score parse failed.', signals_for: [], signals_against: [] };
  }
}

/**
 * Score a batch of candidates. Returns results in the same order as input.
 * Each call makes one LLM request per candidate (allows full evidence per candidate).
 * For large batches, run in parallel with a concurrency cap.
 *
 * @param {object[]} candidates  - Array of {itp, account, evidence, confirmed_positives}
 * @param {number}   [concurrency=5]
 * @returns {Promise<Array<{score, tier, reasoning, signals_for, signals_against}>>}
 */
export async function scoreBatch(candidates, concurrency = 5) {
  const results = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(c => scoreCandidate(c)));
    batchResults.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

function buildBuyerContext(itp) {
  if (!itp.search_profile) return '';
  const parts = [];
  if (itp.search_profile.buyer_descriptions?.length) {
    parts.push(`Typical buyers include: ${itp.search_profile.buyer_descriptions.join(', ')}.`);
  }
  if (itp.search_profile.customer_sic_codes?.length) {
    parts.push(`Existing customers commonly have SIC codes: ${itp.search_profile.customer_sic_codes.join(', ')}.`);
  }
  return parts.join(' ');
}
