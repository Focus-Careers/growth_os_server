import puppeteer from 'puppeteer';

const PUPPETEER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

/**
 * Scrape multiple paths on a domain using a single browser instance.
 * Returns an array of { path, html } for paths that succeeded.
 */
export async function scrapeWithPuppeteer(baseUrl, paths, { timeout = 15000 } = {}) {
  let browser;
  const results = [];
  try {
    console.log(`[puppeteer] Launching browser for ${baseUrl} (${paths.length} paths)`);
    browser = await launchBrowser();

    for (const path of paths) {
      const url = `${baseUrl}${path}`;
      try {
        const page = await browser.newPage();
        await page.setUserAgent(PUPPETEER_UA);
        await page.goto(url, { waitUntil: 'networkidle2', timeout });
        const html = await page.content();
        await page.close();
        console.log(`[puppeteer] Got ${html.length} chars from ${url}`);
        results.push({ path, html });
      } catch (err) {
        console.error(`[puppeteer] Error for ${url}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[puppeteer] Failed to launch browser for ${baseUrl}:`, err.message);
  } finally {
    if (browser) await browser.close();
  }
  return results;
}

/**
 * Fetch a single page using headless Chrome.
 */
export async function fetchWithPuppeteer(url, { timeout = 15000 } = {}) {
  let browser;
  try {
    console.log(`[puppeteer] Launching browser for ${url}`);
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setUserAgent(PUPPETEER_UA);
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
