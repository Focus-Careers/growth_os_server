import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as cheerio from 'cheerio';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { fetchWithPuppeteer } from '../../../../config/puppeteer_fallback.js';

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

function isCloudflare(html) {
  return html.includes('cf-browser-verification') || html.includes('challenge-platform')
    || html.includes('cf_chl_opt') || (html.includes('Just a moment') && html.includes('cloudflare'));
}

function extractText(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.length > 100 ? text.slice(0, 8000) : null;
}

async function fetchPage(url, usePuppeteer = false) {
  // If already flagged for Puppeteer, skip normal fetch
  if (usePuppeteer) {
    const html = await fetchWithPuppeteer(url);
    if (!html) return null;
    if (isCloudflare(html)) {
      console.log(`[analyse_website] ${url} → Puppeteer still blocked by Cloudflare`);
      return null;
    }
    const text = extractText(html);
    console.log(`[analyse_website] ${url} → ${text?.length ?? 0} chars (via Puppeteer)`);
    return text;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    clearTimeout(timeout);

    console.log(`[analyse_website] ${url} → HTTP ${res.status}`);

    // On 403 or other block, return 'blocked' so caller can retry with Puppeteer
    if (res.status === 403) return 'blocked';
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;

    const html = await res.text();

    if (isCloudflare(html)) {
      console.log(`[analyse_website] ${url} → BLOCKED by Cloudflare challenge`);
      return 'blocked';
    }

    const text = extractText(html);
    console.log(`[analyse_website] ${url} → ${text?.length ?? 0} chars`);
    return text;
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
  let needsPuppeteer = false;

  // First pass: try normal fetch
  for (const path of PAGES_TO_TRY) {
    const result = await fetchPage(`${baseUrl}${path}`);
    if (result === 'blocked') {
      needsPuppeteer = true;
      break;
    }
    if (result) pages.push({ path, text: result });
    await new Promise(r => setTimeout(r, 500));
  }

  // Second pass: Puppeteer fallback if blocked
  if (needsPuppeteer && pages.length === 0) {
    console.log(`[analyse_website] Fetch blocked for ${domain}, retrying with Puppeteer`);
    for (const path of PAGES_TO_TRY) {
      const text = await fetchPage(`${baseUrl}${path}`, true);
      if (text && text !== 'blocked') pages.push({ path, text });
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (pages.length === 0) {
    console.log(`[analyse_website] No usable content from ${domain}`);
    return null;
  }

  return pages.map(p => `[Page: ${p.path}]\n${p.text}`).join('\n\n---\n\n');
}

export async function executeSkill({ website, user_details_id }) {
  const [prompt, websiteText] = await Promise.all([
    loadPrompt(),
    fetchWebsiteText(website),
  ]);

  // Build context — use website content if available, fall back to account data
  let context = '';
  if (websiteText) {
    context = `Website content:\n${websiteText}`;
  } else {
    // Fetch account data as fallback context
    const admin = getSupabaseAdmin();
    const { data: ud } = await admin.from('user_details').select('account_id').eq('id', user_details_id).single();
    if (ud?.account_id) {
      const { data: account } = await admin.from('account')
        .select('organisation_name, description, problem_solved')
        .eq('id', ud.account_id).single();
      if (account) {
        const parts = [];
        if (account.organisation_name) parts.push(`Company name: ${account.organisation_name}`);
        if (account.description) parts.push(`Description: ${account.description}`);
        if (account.problem_solved) parts.push(`Problem solved: ${account.problem_solved}`);
        context = parts.length > 0 ? `Known information about this company:\n${parts.join('\n')}` : '';
      }
    }
  }

  const message = await getOpenAI().chat.completions.create({
    model: 'gpt-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nWebsite URL: ${website}\n\n${context}`,
      },
    ],
  });

  const raw = message.choices[0].message.content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
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
