import * as cheerio from 'cheerio';
import { scrapeWithPuppeteer } from './puppeteer_fallback.js';

const COMMON_PATHS = ['/', '/about', '/about-us', '/team', '/our-team', '/contact', '/contact-us', '/people', '/staff'];
const FETCH_TIMEOUT = 10000;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function isCloudflare(html) {
  return html.includes('cf-browser-verification') || html.includes('challenge-platform')
    || html.includes('cf_chl_opt') || (html.includes('Just a moment') && html.includes('cloudflare'));
}

function processHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const rawEmails = html.match(emailRegex) ?? [];
  const emails = rawEmails.filter(e => {
    const lower = e.toLowerCase();
    return !lower.includes('example.com') && !lower.includes('wixpress') && !lower.includes('sentry') && !lower.endsWith('.png') && !lower.endsWith('.jpg');
  });

  return { text, emails };
}

/**
 * Scrape a website for text content and email addresses.
 * Tries normal fetch first, falls back to Puppeteer if Cloudflare blocks.
 */
export async function scrapeWebsite(domain) {
  const baseUrl = `https://${domain}`;
  const allText = [];
  const foundEmails = new Set();
  let blocked = false;

  // First pass: normal fetch
  for (const path of COMMON_PATHS) {
    try {
      const url = `${baseUrl}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
      clearTimeout(timeout);

      if (res.status === 403) {
        console.log(`[scraper] ${url} → HTTP 403`);
        blocked = true;
        break;
      }
      if (!res.ok) {
        console.log(`[scraper] ${url} → HTTP ${res.status}`);
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) continue;

      const html = await res.text();

      if (isCloudflare(html)) {
        console.log(`[scraper] ${url} → BLOCKED by Cloudflare challenge`);
        blocked = true;
        break;
      }

      const { text, emails } = processHtml(html);
      if (text.length > 100) {
        allText.push({ path, text: text.slice(0, 5000) });
      }
      emails.forEach(e => foundEmails.add(e.toLowerCase()));

      console.log(`[scraper] ${url} → ${text.length} chars, ${emails.length} emails`);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.log(`[scraper] ${baseUrl}${path} → error: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Puppeteer fallback if blocked and we got nothing
  if (blocked && allText.length === 0) {
    console.log(`[scraper] Fetch blocked for ${domain}, retrying with Puppeteer`);
    const puppeteerResults = await scrapeWithPuppeteer(baseUrl, COMMON_PATHS);
    for (const { path, html } of puppeteerResults) {
      if (isCloudflare(html)) continue;
      const { text, emails } = processHtml(html);
      if (text.length > 100) {
        allText.push({ path, text: text.slice(0, 5000) });
      }
      emails.forEach(e => foundEmails.add(e.toLowerCase()));
      console.log(`[scraper] ${baseUrl}${path} → ${text.length} chars, ${emails.length} emails (via Puppeteer)`);
    }
  }

  return {
    text: allText.map(p => `[Page: ${p.path}]\n${p.text}`).join('\n\n---\n\n'),
    emails: [...foundEmails],
    pagesScraped: allText.length,
  };
}
