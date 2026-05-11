import * as cheerio from 'cheerio';
import { scrapeWithPuppeteer } from '../../config/puppeteer_fallback.js';

const FETCH_TIMEOUT_MS = 10000;
const POLITENESS_DELAY_MS = 300;
const DEFAULT_CONCURRENCY = 3;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/** Page path sets for different scraping modes */
export const PAGE_SETS = {
  homepage_only: ['/'],
  homepage_plus_about_contact: ['/', '/about', '/about-us', '/contact', '/contact-us', '/team', '/our-team'],
  full: [
    '/', '/about', '/about-us', '/team', '/our-team', '/people', '/staff',
    '/contact', '/contact-us', '/services', '/what-we-do', '/products',
  ],
};

function isCloudflare(html) {
  return (
    html.includes('cf-browser-verification') ||
    html.includes('challenge-platform') ||
    html.includes('cf_chl_opt') ||
    (html.includes('Just a moment') && html.includes('cloudflare'))
  );
}

function processHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const rawEmails = html.match(emailRegex) ?? [];
  const emails = rawEmails.filter(e => {
    const lower = e.toLowerCase();
    return (
      !lower.includes('example.com') &&
      !lower.includes('wixpress') &&
      !lower.includes('sentry') &&
      !lower.endsWith('.png') &&
      !lower.endsWith('.jpg') &&
      !lower.endsWith('.gif')
    );
  });

  return { text, emails };
}

async function fetchOnePage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: FETCH_HEADERS,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (res.status === 403) return { blocked: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) return { error: 'non-html content-type' };

    const html = await res.text();
    if (isCloudflare(html)) return { blocked: true };
    return { html };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

/**
 * Scrape a website and return structured per-page content.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {'homepage_only'|'homepage_plus_about_contact'|'full'} [params.page_set='homepage_plus_about_contact']
 * @param {number} [params.concurrency=3]  - Max parallel fetches (within the same domain — always polite)
 *
 * @returns {Promise<{
 *   domain: string,
 *   fetched_at: string,
 *   pages: Array<{path: string, text: string, emails: string[]}>,
 *   all_text: string,
 *   all_emails: string[],
 *   pages_scraped: number,
 *   blocked: boolean,
 *   error?: string,
 * }>}
 */
export async function scrapeSite({
  domain,
  page_set = 'homepage_plus_about_contact',
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const paths = PAGE_SETS[page_set] ?? PAGE_SETS.homepage_plus_about_contact;
  const baseUrl = `https://${domain}`;
  const foundEmails = new Set();
  const pages = [];
  let blocked = false;

  // Fetch paths in batches of `concurrency`, with a short politeness delay between batches
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);

    const fetched = await Promise.all(
      batch.map(path =>
        fetchOnePage(`${baseUrl}${path}`).then(r => ({ path, ...r }))
      )
    );

    for (const result of fetched) {
      if (result.blocked) {
        blocked = true;
        break;
      }
      if (result.error || !result.html) {
        console.log(`[scraper] ${baseUrl}${result.path} → ${result.error ?? 'no html'}`);
        continue;
      }
      const { text, emails } = processHtml(result.html);
      if (text.length > 100) {
        pages.push({ path: result.path, text: text.slice(0, 5000), emails });
        emails.forEach(e => foundEmails.add(e.toLowerCase()));
        console.log(`[scraper] ${baseUrl}${result.path} → ${text.length} chars, ${emails.length} emails`);
      }
    }

    if (blocked) break;

    // Politeness delay between batches (skip after last batch)
    if (i + concurrency < paths.length) {
      await new Promise(r => setTimeout(r, POLITENESS_DELAY_MS));
    }
  }

  // Puppeteer fallback when blocked and we got nothing
  if (blocked && pages.length === 0) {
    console.log(`[scraper] Blocked on ${domain}, retrying with Puppeteer`);
    try {
      const puppeteerResults = await scrapeWithPuppeteer(baseUrl, paths);
      for (const { path, html } of puppeteerResults) {
        if (!html || isCloudflare(html)) continue;
        const { text, emails } = processHtml(html);
        if (text.length > 100) {
          pages.push({ path, text: text.slice(0, 5000), emails });
          emails.forEach(e => foundEmails.add(e.toLowerCase()));
          console.log(`[scraper] ${baseUrl}${path} → ${text.length} chars, ${emails.length} emails (Puppeteer)`);
        }
      }
      blocked = pages.length === 0;
    } catch (err) {
      console.error(`[scraper] Puppeteer error for ${domain}:`, err.message);
    }
  }

  const allText = pages.map(p => `[Page: ${p.path}]\n${p.text}`).join('\n\n---\n\n');

  return {
    domain,
    fetched_at: new Date().toISOString(),
    pages,
    all_text: allText,
    all_emails: [...foundEmails],
    pages_scraped: pages.length,
    blocked: blocked && pages.length === 0,
  };
}
