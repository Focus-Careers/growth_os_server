import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Maps an ITP to UK SIC codes using Claude, with DB caching.
 * Returns an array of SIC code strings, e.g. ["43320", "41201"]
 */
export async function mapItpToSicCodes(itp) {
  // Check cache first
  if (itp.sic_codes && Array.isArray(itp.sic_codes) && itp.sic_codes.length > 0) {
    console.log(`[sic_code_mapper] Using cached SIC codes for ITP ${itp.id}: ${itp.sic_codes.join(', ')}`);
    return itp.sic_codes;
  }

  const prompt = await readFile(join(__dirname, 'prompt_sic_codes.md'), 'utf-8');

  const context = [
    `ITP Name: ${itp.name ?? 'Unnamed'}`,
    `Summary: ${itp.itp_summary ?? ''}`,
    `Demographics: ${itp.itp_demographic ?? ''}`,
    `Pain Points: ${itp.itp_pain_points ?? ''}`,
    `Buying Triggers: ${itp.itp_buying_trigger ?? ''}`,
    `Location: ${itp.location ?? 'UK'}`,
  ].join('\n');

  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: prompt,
    messages: [{ role: 'user', content: context }],
  });

  const text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let sicCodes;
  try {
    sicCodes = JSON.parse(text);
    if (!Array.isArray(sicCodes)) throw new Error('Not an array');
  } catch {
    console.error('[sic_code_mapper] Failed to parse SIC codes:', text);
    return [];
  }

  console.log(`[sic_code_mapper] Generated SIC codes for ITP ${itp.id}: ${sicCodes.join(', ')}`);

  // Cache to DB
  const admin = getSupabaseAdmin();
  await admin.from('itp').update({ sic_codes: sicCodes }).eq('id', itp.id);

  return sicCodes;
}
