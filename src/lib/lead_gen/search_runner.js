import { isDomainBlocked } from '../../employees/lead_gen_expert/skills/target_finder_ten_leads/domain_resolver.js';

const SERPER_URL = 'https://google.serper.dev/search';

// Title patterns that indicate the result is not a company homepage
const JUNK_TITLE_RE = /^\[pdf\]|^\[doc\]|catalogue|brochure|directory|magazine|journal|^\s*news\b|wikipedia|linkedin\.com|facebook\.com|twitter\.com|instagram\.com|youtube\.com/i;

/**
 * Run a list of search queries through Serper and return deduplicated results.
 *
 * @param {object} params
 * @param {string[]} params.queries              - List of search query strings
 * @param {number}  [params.results_per_query=10] - How many results to request per query
 * @param {string}  [params.location]            - Location bias, e.g. "United Kingdom"
 * @param {number}  [params.max_results]         - Hard cap on total results returned (deduped by domain)
 * @param {Set}     [params.seen_domains]        - Pre-populated dedup set (modified in place)
 *
 * @returns {Promise<{
 *   results: Array<{url, domain, query, title, snippet}>,
 *   queries_run: number,
 *   serper_calls: number,
 * }>}
 */
export async function runSearchQueries({
  queries,
  results_per_query = 10,
  location,
  max_results,
  seen_domains,
}) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('search_runner: SERPER_API_KEY is not set');

  const dedup = seen_domains instanceof Set ? seen_domains : new Set();
  const results = [];
  const queriesUsed = [];
  let queriesRun = 0;

  for (const query of queries) {
    if (max_results != null && results.length >= max_results) break;

    let serperData;
    try {
      const res = await fetch(SERPER_URL, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: results_per_query,
          hl: 'en',
          ...(location ? { location } : {}),
        }),
      });
      serperData = await res.json();
      if (!res.ok) {
        console.error(`[search_runner] Serper error for "${query}":`, JSON.stringify(serperData).slice(0, 200));
        continue;
      }
    } catch (err) {
      console.error(`[search_runner] Network error for "${query}":`, err.message);
      continue;
    }

    queriesRun++;
    queriesUsed.push(query);

    for (const item of serperData.organic ?? []) {
      if (max_results != null && results.length >= max_results) break;
      if (!item.link) continue;
      if (JUNK_TITLE_RE.test(item.title ?? '')) continue;

      let domain;
      try {
        domain = new URL(item.link).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }

      if (isDomainBlocked(domain)) continue;
      if (dedup.has(domain)) continue;
      dedup.add(domain);

      results.push({
        url: item.link,
        domain,
        query,
        title: item.title ?? null,
        snippet: item.snippet ?? null,
      });
    }

    console.log(`[search_runner] Query ${queriesRun}/${queries.length}: "${query}" → ${results.length} total results so far`);
  }

  console.log(`[search_runner] Completed: ${results.length} unique results from ${queriesRun} Serper calls`);
  return { results, queries_used: queriesUsed, queries_run: queriesRun, serper_calls: queriesRun };
}
