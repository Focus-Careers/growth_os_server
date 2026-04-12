import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function callClaudeForSicCodes(itp) {
  const prompt = await readFile(join(__dirname, 'prompt_sic_codes.md'), 'utf-8');

  const context = [
    `ITP Name: ${itp.name ?? 'Unnamed'}`,
    `Summary: ${itp.itp_summary ?? ''}`,
    `Demographics: ${itp.itp_demographic ?? ''}`,
    `Pain Points: ${itp.itp_pain_points ?? ''}`,
    `Buying Triggers: ${itp.itp_buying_trigger ?? ''}`,
    `Location: ${itp.location ?? 'UK'}`,
  ].join('\n');

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5-mini',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: context },
    ],
  });

  const text = response.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
  } catch {
    console.error('[sic_code_mapper] Failed to parse SIC codes:', text);
    return [];
  }

  return parsed;
}

/**
 * Generate SIC codes with descriptions for user approval.
 * Returns [{ code: "43320", description: "Joinery installation — ..." }, ...]
 * Does NOT cache to DB — caching happens after user approves.
 */
export async function generateSicCodesWithDescriptions(itp) {
  const result = await callClaudeForSicCodes(itp);

  // Ensure we have objects with code + description
  const codes = result.map(item => {
    if (typeof item === 'string') return { code: item, description: `SIC ${item}` };
    return { code: item.code ?? item, description: item.description ?? `SIC ${item.code}` };
  });

  console.log(`[sic_code_mapper] Generated ${codes.length} SIC codes with descriptions for ITP ${itp.id}`);
  return codes;
}

/**
 * Maps an ITP to UK SIC codes using Claude, with DB caching.
 * Returns an array of SIC code strings, e.g. ["43320", "41201"]
 * Used by target finder — expects codes to already be cached from the approval step.
 */
export async function mapItpToSicCodes(itp) {
  // Check cache first
  if (itp.sic_codes && Array.isArray(itp.sic_codes) && itp.sic_codes.length > 0) {
    console.log(`[sic_code_mapper] Using cached SIC codes for ITP ${itp.id}: ${itp.sic_codes.join(', ')}`);
    return itp.sic_codes;
  }

  // Fallback: generate and cache (for ITPs created before the approval step existed)
  const result = await callClaudeForSicCodes(itp);
  const sicCodes = result.map(item => typeof item === 'string' ? item : item.code);

  if (sicCodes.length === 0) return [];

  console.log(`[sic_code_mapper] Generated SIC codes for ITP ${itp.id}: ${sicCodes.join(', ')}`);

  const admin = getSupabaseAdmin();
  await admin.from('itp').update({ sic_codes: sicCodes }).eq('id', itp.id);

  return sicCodes;
}
