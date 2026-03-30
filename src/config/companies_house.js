const CH_BASE_URL = 'https://api.company-information.service.gov.uk';

function getAuthHeader() {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  // Companies House uses Basic auth with API key as username, no password
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Advanced search for companies by SIC codes and/or location.
 * Returns up to `size` results per page.
 * @param {{ sicCodes?: string[], location?: string, companyStatus?: string, startIndex?: number, size?: number }} opts
 */
export async function searchCompanies({ sicCodes, location, companyStatus = 'active', startIndex = 0, size = 100 } = {}) {
  const params = new URLSearchParams();
  if (sicCodes?.length) params.set('sic_codes', sicCodes.join(','));
  if (location) params.set('location', location);
  if (companyStatus) params.set('company_status', companyStatus);
  params.set('start_index', String(startIndex));
  params.set('size', String(size));

  const url = `${CH_BASE_URL}/advanced-search/companies?${params}`;
  console.log(`[companies_house] Search: ${url}`);

  try {
    const res = await fetch(url, {
      headers: { Authorization: getAuthHeader() },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[companies_house] Search failed (${res.status}):`, body);
      return { items: [], total_results: 0 };
    }

    const data = await res.json();
    console.log(`[companies_house] Search returned ${data.items?.length ?? 0} of ${data.total_results ?? 0} total`);
    await delay(500);
    return data;
  } catch (err) {
    console.error('[companies_house] Search error:', err.message);
    return { items: [], total_results: 0 };
  }
}

/**
 * Get full company profile by company number.
 * @param {string} companyNumber
 */
export async function getCompanyProfile(companyNumber) {
  const url = `${CH_BASE_URL}/company/${companyNumber}`;
  console.log(`[companies_house] Profile: ${companyNumber}`);

  try {
    const res = await fetch(url, {
      headers: { Authorization: getAuthHeader() },
    });

    if (!res.ok) {
      console.error(`[companies_house] Profile failed (${res.status}) for ${companyNumber}`);
      return null;
    }

    const data = await res.json();
    await delay(500);
    return data;
  } catch (err) {
    console.error(`[companies_house] Profile error for ${companyNumber}:`, err.message);
    return null;
  }
}

/**
 * Get officers (directors, secretaries) for a company.
 * @param {string} companyNumber
 */
export async function getCompanyOfficers(companyNumber) {
  const url = `${CH_BASE_URL}/company/${companyNumber}/officers`;
  console.log(`[companies_house] Officers: ${companyNumber}`);

  try {
    const res = await fetch(url, {
      headers: { Authorization: getAuthHeader() },
    });

    if (!res.ok) {
      console.error(`[companies_house] Officers failed (${res.status}) for ${companyNumber}`);
      return [];
    }

    const data = await res.json();
    const active = (data.items ?? []).filter(o => !o.resigned_on);
    console.log(`[companies_house] Officers: ${active.length} active of ${data.items?.length ?? 0} total`);
    await delay(500);
    return active;
  } catch (err) {
    console.error(`[companies_house] Officers error for ${companyNumber}:`, err.message);
    return [];
  }
}
