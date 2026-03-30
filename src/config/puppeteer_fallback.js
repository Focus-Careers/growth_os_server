import puppeteer from 'puppeteer';

/**
 * Fetch a page using headless Chrome. Used as a fallback when
 * normal fetch gets blocked by Cloudflare or returns 403.
 *
 * @param {string} url - The URL to fetch
 * @param {{ timeout?: number }} opts
 * @returns {Promise<string|null>} - The page HTML, or null on failure
 */
export async function fetchWithPuppeteer(url, { timeout = 15000 } = {}) {
  let browser;
  try {
    console.log(`[puppeteer] Launching browser for ${url}`);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    const html = await page.content();
    console.log(`[puppeteer] Got ${html.length} chars from ${url}`);
    return html;
  } catch (err) {
    console.error(`[puppeteer] Error for ${url}:`, err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}
