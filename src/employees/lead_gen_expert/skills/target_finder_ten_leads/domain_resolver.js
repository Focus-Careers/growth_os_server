import { searchCompaniesByName } from '../../../../config/apollo.js';

// Exact domain matches
const BLOCKED_DOMAINS = new Set([
  'yell.com', 'checkatrade.com', 'linkedin.com', 'companieshouse.gov.uk',
  'facebook.com', 'twitter.com', 'instagram.com', 'dnb.com',
  'glassdoor.com', 'trustatrader.com', 'bark.com', 'houzz.com', 'cylex-uk.co.uk',
  'scoot.co.uk', 'thomsonlocal.com', '192.com', 'companycheck.co.uk',
  'google.com', 'youtube.com', 'yelp.com', 'trustpilot.com', 'freeindex.co.uk',
  'wikipedia.org', 'gov.uk', 'amazon.co.uk', 'amazon.com', 'ebay.co.uk',
  'pinterest.com', 'tiktok.com', 'reddit.com', 'bbc.co.uk', 'theguardian.com',
  'telegraph.co.uk', 'independent.co.uk', 'mirror.co.uk', 'indeed.com',
  'reed.co.uk', 'totaljobs.com', 'gumtree.com', 'rightmove.co.uk',
  'zoopla.co.uk', 'companies-house.gov.uk', 'find-and-update.company-information.service.gov.uk',
  // Company data aggregators / directories (caught in testing)
  'credencedata.com', 'tracxn.com', 'thegazette.co.uk', 'businessnetwork.co.uk',
  'bookabuilderuk.com', 'hamuch.com', 'northdata.com', 'zoominfo.com',
  'mybuilder.com', 'beta.companieshouse.gov.uk', 'ceginformacio.hu',
  // Round 2 blocklist additions
  'graphlytic.com', 'companieshousedata.co.uk', 'planningsignal.co.uk',
  'firstreport.co.uk', 'solocheck.ie', 'opengovuk.com', 'lei-ireland.ie',
  'bizdb.co.uk', 'businessmad.com', 'checkfree.co.uk', 'britishlei.co.uk',
  'pappers.co.uk', 'bringo.co.uk', 'gladiatorbusiness.co.uk', 'tinytax.co.uk',
  'theconstructionindex.co.uk', 'tradesmanregistry.co.uk',
  // Round 3 blocklist additions (caught in prod logs 2026-04-08)
  'northdata.de', 'companiesintheuk.co.uk', 'vat-search.co.uk', 'ceoemail.com',
  'pomanda.com', 'procurement.co.uk', 'doogal.co.uk', 'tandlonline.com',
  'reportingaccounts.com', 'companydex.co.uk', 'uk.globaldatabase.com',
  '1stdirectory.co.uk', 'nextdoor.co.uk', 'addressesandpostcodes.co.uk',
  'companypulse.co.uk', 'vat-lookup.co.uk', 'ukphonebook.com', 'creditsafe.com',
  'wastebook.co.uk', 'search.infobelpro.com', 'stratfordiq.com', 'datalog.co.uk',
  'scoriff.co.uk', 'secret-bases.co.uk', 'amazonaws.com', 'streetguide.co.uk',
  // Round 4 blocklist additions (caught in prod logs 2026-04-10)
  'bloomberg.com', 'rocketreach.co', 'rocketreach.com',
  'company-information.service.gov.uk', 'ico.org.uk',
  'directory.mirror.co.uk', 'verif.com', 'verif.co.uk',
  'trademarkia.com', 'mapquest.com', 'mapolist.com',
  'archive.org', 'futureoflife.org',
  'companydatashop.com', 'checkcompany.co.uk', 'bizstats.co.uk',
  'f6s.com', 'b2bhint.com', 'uktradeinfo.com', 'adsgroup.org.uk',
  'crunchbase.com', 'legalentityidentifier.co.uk',
  // Round 5 — trades aggregators and quote platforms
  'ratedpeople.com', 'rated-people.com', 'bidvine.com', 'habitissimo.co.uk',
  'craftjack.co.uk', 'workatrader.co.uk', 'tradesmenlive.co.uk',
  'local.com', 'brownbook.net', 'ufindus.com', 'businessmagnet.co.uk',
  'wampit.co.uk', 'listabusiness.co.uk', 'fyple.co.uk', 'hotfrog.co.uk',
  'n49.co.uk', 'tipped.co.uk', 'uk.enrollbusiness.com', 'cybo.com',
]);

// Suffix matches — blocks any subdomain (e.g. open.endole.co.uk, gb.kompass.com)
// 'gov.uk' catches company-information.service.gov.uk and all other gov subdomains
const BLOCKED_SUFFIXES = [
  'endole.co.uk', 'kompass.com', 'linkedin.com', 'companieshouse.gov.uk',
  'lursoft.lv', 'facebook.com', 'youcontrol.com.ua',
  'gov.uk', 'gov.com',
];

export function isDomainBlocked(domain) {
  if (BLOCKED_DOMAINS.has(domain)) return true;
  return BLOCKED_SUFFIXES.some(suffix => domain === suffix || domain.endsWith('.' + suffix));
}

/**
 * Extract root domain from a URL.
 */
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Resolve a company's website domain using Serper (free) then Apollo (fallback).
 * @param {string} companyName
 * @param {string} location - Town/city or full address
 * @returns {Promise<string|null>} - Root domain or null
 */
export async function resolveDomain(companyName, location) {
  // Step A: Serper search
  const domain = await resolveViaSerper(companyName, location);
  if (domain) return domain;

  // Step B: Apollo fallback
  return resolveViaApollo(companyName);
}

async function resolveViaSerper(companyName, location) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  // Extract just the town/city from the location string
  const locationShort = location?.split(',')[0]?.trim() ?? '';
  const query = `"${companyName}" ${locationShort}`.trim();

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5, hl: 'en' }),
    });
    const data = await res.json();
    const results = data.organic ?? [];

    for (const result of results) {
      const domain = extractDomain(result.link);
      if (domain && !isDomainBlocked(domain)) {
        console.log(`[domain_resolver] Serper resolved "${companyName}" → ${domain}`);
        return domain;
      }
    }

    console.log(`[domain_resolver] Serper found no usable domain for "${companyName}"`);
    return null;
  } catch (err) {
    console.error(`[domain_resolver] Serper error for "${companyName}":`, err.message);
    return null;
  }
}

async function resolveViaApollo(companyName) {
  try {
    const orgs = await searchCompaniesByName(companyName);
    if (orgs.length > 0 && orgs[0].primary_domain) {
      const domain = orgs[0].primary_domain;
      console.log(`[domain_resolver] Apollo resolved "${companyName}" → ${domain}`);
      return domain;
    }
    console.log(`[domain_resolver] Apollo found no domain for "${companyName}"`);
    return null;
  } catch (err) {
    console.error(`[domain_resolver] Apollo error for "${companyName}":`, err.message);
    return null;
  }
}
