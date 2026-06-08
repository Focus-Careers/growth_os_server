/**
 * Generate lookalike sending-domain suggestions for a company's primary domain.
 * Strips the TLD/subdomain to a slug, then prefixes/suffixes it into safe variants.
 * Only .com / .co (no novelty TLDs).
 */

const PREFIXES = ['get', 'try', 'use', 'go', 'with'];
const SUFFIXES = ['hq', 'mail', 'team', 'app', 'co'];

function slugFromDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0];
  s = s.split('.')[0];
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

/**
 * @param {string} primaryDomain - Company's real domain (e.g. "acme.com", "https://acme.com/")
 * @param {object} [opts]
 * @param {number} [opts.count=5] - How many suggestions to return
 * @returns {string[]} Suggested sending domains, e.g. ["getacme.com", "tryacme.com", ...]
 */
export function suggestDomains(primaryDomain, { count = 5 } = {}) {
  const slug = slugFromDomain(primaryDomain);
  if (!slug) return [];

  const candidates = new Set();

  for (const p of PREFIXES) {
    candidates.add(`${p}${slug}.com`);
  }
  for (const s of SUFFIXES) {
    if (s === 'co') candidates.add(`${slug}.co`);
    else            candidates.add(`${slug}${s}.com`);
  }
  candidates.add(`${slug}.co`);
  candidates.add(`the${slug}.com`);

  return Array.from(candidates).slice(0, count);
}

export { slugFromDomain };
