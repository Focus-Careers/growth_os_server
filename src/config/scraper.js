import * as cheerio from 'cheerio';

const COMMON_PATHS = ['/', '/about', '/about-us', '/team', '/our-team', '/contact', '/contact-us', '/people', '/staff'];
const FETCH_TIMEOUT = 10000; // 10 seconds

/**
 * Scrape a website for text content and email addresses.
 * Tries the homepage and common paths, extracts text and emails.
 */
export async function scrapeWebsite(domain) {
  const baseUrl = `https://${domain}`;
  const allText = [];
  const foundEmails = new Set();

  for (const path of COMMON_PATHS) {
    try {
      const url = `${baseUrl}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GrowthOS/1.0)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) continue;

      const html = await res.text();
      const $ = cheerio.load(html);

      // Remove scripts, styles, nav, footer to reduce noise
      $('script, style, nav, footer, header, noscript, svg, iframe').remove();

      // Extract text
      const text = $('body').text().replace(/\s+/g, ' ').trim();
      if (text.length > 100) {
        allText.push({ path, text: text.slice(0, 5000) }); // Cap per page
      }

      // Extract emails from the raw HTML
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = html.match(emailRegex) ?? [];
      emails.forEach(e => {
        // Filter out common false positives
        const lower = e.toLowerCase();
        if (!lower.includes('example.com') && !lower.includes('wixpress') && !lower.includes('sentry') && !lower.endsWith('.png') && !lower.endsWith('.jpg')) {
          foundEmails.add(lower);
        }
      });

      console.log(`[scraper] ${url} → ${text.length} chars, ${emails.length} emails`);
    } catch (err) {
      // Timeout or fetch error — skip this path
      if (err.name !== 'AbortError') {
        console.log(`[scraper] ${baseUrl}${path} → error: ${err.message}`);
      }
    }

    // Rate limit: small delay between pages
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    text: allText.map(p => `[Page: ${p.path}]\n${p.text}`).join('\n\n---\n\n'),
    emails: [...foundEmails],
    pagesScraped: allText.length,
  };
}
