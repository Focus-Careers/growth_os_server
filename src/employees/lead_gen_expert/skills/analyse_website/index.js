import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as cheerio from 'cheerio';
import { getAnthropic } from '../../../../config/anthropic.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FETCH_TIMEOUT = 10000;
const PAGES_TO_TRY = ['/', '/about', '/about-us'];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache',
};

async function loadPrompt() {
  return readFile(join(__dirname, 'prompt.md'), 'utf-8');
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    clearTimeout(timeout);

    console.log(`[analyse_website] ${url} → HTTP ${res.status}`);
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;

    const html = await res.text();

    // Detect Cloudflare challenge
    if (html.includes('cf-browser-verification') || html.includes('challenge-platform')
      || html.includes('cf_chl_opt') || (html.includes('Just a moment') && html.includes('cloudflare'))) {
      console.log(`[analyse_website] ${url} → BLOCKED by Cloudflare challenge`);
      return null;
    }

    // Clean with cheerio
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg, iframe').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    console.log(`[analyse_website] ${url} → ${text.length} chars`);
    return text.length > 100 ? text.slice(0, 8000) : null;
  } catch (err) {
    clearTimeout(timeout);
    console.log(`[analyse_website] ${url} → error: ${err.message}`);
    return null;
  }
}

async function fetchWebsiteText(url) {
  const domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const baseUrl = `https://${domain}`;
  const pages = [];

  for (const path of PAGES_TO_TRY) {
    const text = await fetchPage(`${baseUrl}${path}`);
    if (text) pages.push({ path, text });
    await new Promise(r => setTimeout(r, 500));
  }

  if (pages.length === 0) {
    console.log(`[analyse_website] No usable content from ${domain}`);
    return `[Website content could not be retrieved for ${domain}. The site may be behind Cloudflare protection or unavailable.]`;
  }

  return pages.map(p => `[Page: ${p.path}]\n${p.text}`).join('\n\n---\n\n');
}

export async function executeSkill({ website, user_details_id }) {
  const [prompt, websiteText] = await Promise.all([
    loadPrompt(),
    fetchWebsiteText(website),
  ]);

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nWebsite URL: ${website}\n\nWebsite content:\n${websiteText}`,
      },
    ],
  });

  const raw = message.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let analysis;
  try {
    analysis = JSON.parse(raw);
  } catch (parseError) {
    console.error('[analyse_website] Failed to parse Claude response as JSON:', parseError.message, '| raw text:', raw);
    analysis = {};
  }

  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'analyse_website',
    user_details_id,
    output: analysis,
  });

  return { user_details_id, analysis };
}
