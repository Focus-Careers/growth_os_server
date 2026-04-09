const CH_BASE_URL = 'https://api.company-information.service.gov.uk';

// Shared rate-limit queue — controls all CH API calls across concurrent runs.
// CH allows 600 requests/5 minutes = 2/sec. We target 1 per 200ms (300/min) for headroom.
// Because this is module-level, all concurrent skill runs share the same queue.
const QUEUE_INTERVAL_MS = 200;
let queueTail = Promise.resolve();

function enqueue(fn) {
  const result = queueTail.then(() => fn());
  queueTail = result
    .then(() => new Promise(r => setTimeout(r, QUEUE_INTERVAL_MS)))
    .catch(() => new Promise(r => setTimeout(r, QUEUE_INTERVAL_MS)));
  return result;
}

function getAuthHeader() {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

/**
 * Advanced search for companies by SIC codes and/or location.
 */
export async function searchCompanies({ sicCodes, location, companyName, companyStatus = 'active', startIndex = 0, size = 100 } = {}) {
  if (companyName && !sicCodes?.length) {
    const params = new URLSearchParams({ q: companyName, items_per_page: String(size) });
    const url = `${CH_BASE_URL}/search/companies?${params}`;
    console.log(`[companies_house] Name search: ${url}`);
    return enqueue(async () => {
      try {
        const res = await fetch(url, { headers: { Authorization: getAuthHeader() } });
        if (!res.ok) { console.error(`[companies_house] Name search failed (${res.status})`); return { items: [], total_results: 0 }; }
        const data = await res.json();
        console.log(`[companies_house] Name search returned ${data.items?.length ?? 0} results`);
        return data;
      } catch (err) { console.error('[companies_house] Name search error:', err.message); return { items: [], total_results: 0 }; }
    });
  }

  const params = new URLSearchParams();
  if (sicCodes?.length) params.set('sic_codes', sicCodes.join(','));
  if (location) params.set('location', location);
  if (companyStatus) params.set('company_status', companyStatus);
  params.set('start_index', String(startIndex));
  params.set('size', String(size));

  const url = `${CH_BASE_URL}/advanced-search/companies?${params}`;
  console.log(`[companies_house] Search: ${url}`);

  return enqueue(async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: getAuthHeader() } });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[companies_house] Search failed (${res.status}):`, body);
        return { items: [], total_results: 0 };
      }
      const data = await res.json();
      console.log(`[companies_house] Search returned ${data.items?.length ?? 0} of ${data.total_results ?? 0} total`);
      return data;
    } catch (err) {
      console.error('[companies_house] Search error:', err.message);
      return { items: [], total_results: 0 };
    }
  });
}

/**
 * Get full company profile by company number.
 */
export async function getCompanyProfile(companyNumber) {
  const url = `${CH_BASE_URL}/company/${companyNumber}`;
  console.log(`[companies_house] Profile: ${companyNumber}`);
  return enqueue(async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: getAuthHeader() } });
      if (!res.ok) { console.error(`[companies_house] Profile failed (${res.status}) for ${companyNumber}`); return null; }
      return await res.json();
    } catch (err) { console.error(`[companies_house] Profile error for ${companyNumber}:`, err.message); return null; }
  });
}

/**
 * Get active officers for a company.
 */
export async function getCompanyOfficers(companyNumber) {
  const url = `${CH_BASE_URL}/company/${companyNumber}/officers`;
  return enqueue(async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: getAuthHeader() } });
      if (!res.ok) { console.error(`[companies_house] Officers failed (${res.status}) for ${companyNumber}`); return []; }
      const data = await res.json();
      const active = (data.items ?? []).filter(o => !o.resigned_on);
      return active;
    } catch (err) { console.error(`[companies_house] Officers error for ${companyNumber}:`, err.message); return []; }
  });
}
