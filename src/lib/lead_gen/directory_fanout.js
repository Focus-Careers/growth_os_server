import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extract individual business listings from a whitelisted directory page.
 *
 * @param {object} params
 * @param {string} params.url                 - URL of the directory page
 * @param {object} params.scraped             - Output from scrapeSite()
 * @param {string} params.directory_identifier - Domain/name of the directory (for logging)
 *
 * @returns {Promise<Array<{
 *   name: string,
 *   location: string|null,
 *   website: string|null,
 *   phone: string|null,
 *   listing_url: string|null,
 * }>>}
 */
export async function extractDirectoryListings({ url, scraped, directory_identifier }) {
  if (!scraped || scraped.pages_scraped === 0 || scraped.all_text.length < 100) {
    console.log(`[directory_fanout] No content to extract from ${url}`);
    return [];
  }

  const prompt = await readFile(join(__dirname, 'prompts/prompt_directory_fanout.md'), 'utf-8');

  const content = [
    `Directory: ${directory_identifier}`,
    `URL: ${url}`,
    '',
    'Page content (up to 6000 chars):',
    scraped.all_text.slice(0, 6000),
  ].join('\n');

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 2048,
      messages: [{ role: 'user', content: `${prompt}\n\n${content}` }],
    });
  } catch (err) {
    console.error(`[directory_fanout] LLM error for ${url}:`, err.message);
    return [];
  }

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  try {
    const listings = JSON.parse(raw);
    if (!Array.isArray(listings)) return [];
    const valid = listings.filter(l => l?.name?.length > 0);
    console.log(`[directory_fanout] Extracted ${valid.length} listings from ${url}`);
    return valid;
  } catch {
    console.error(`[directory_fanout] Parse error for ${url}:`, raw.slice(0, 200));
    return [];
  }
}
