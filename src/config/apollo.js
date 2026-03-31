const APOLLO_BASE_URL = 'https://api.apollo.io/v1';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.APOLLO_API_KEY,
  };
}

/**
 * Enrich a company by domain. Returns company details, socials, and possibly some people.
 * Endpoint: POST /v1/organizations/enrich
 */
export async function enrichCompany(domain) {
  console.log(`[apollo] Company enrichment for ${domain}`);
  try {
    const res = await fetch(`${APOLLO_BASE_URL}/organizations/enrich`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ domain }),
    });
    const data = await res.json();
    console.log(`[apollo] Company enrichment status: ${res.status} | name: ${data.organization?.name ?? 'unknown'}`);
    if (!res.ok) {
      console.error('[apollo] Company enrichment error:', JSON.stringify(data));
      return null;
    }
    return data.organization ?? null;
  } catch (err) {
    console.error(`[apollo] Company enrichment error for ${domain}:`, err.message);
    return null;
  }
}

/**
 * Search for companies by name and/or location.
 * Endpoint: POST /v1/mixed_companies/search
 */
export async function searchCompaniesByName(companyName, locations = ['United Kingdom']) {
  console.log(`[apollo] Company search: "${companyName}" in ${locations.join(', ')}`);
  try {
    const res = await fetch(`${APOLLO_BASE_URL}/mixed_companies/search`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        q_organization_name: companyName,
        organization_locations: locations,
        per_page: 5,
        page: 1,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[apollo] Company search error:', JSON.stringify(data));
      return [];
    }
    const orgs = data.organizations ?? [];
    console.log(`[apollo] Company search returned ${orgs.length} results`);
    return orgs;
  } catch (err) {
    console.error(`[apollo] Company search error for "${companyName}":`, err.message);
    return [];
  }
}

/**
 * Search for people at a company by domain.
 * Endpoint: POST /v1/mixed_people/search
 * Returns array of people with name, title, email, phone, linkedin.
 */
export async function searchPeopleAtCompany(domain, { perPage = 10 } = {}) {
  console.log(`[apollo] People search at ${domain}`);
  try {
    const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        q_organization_domains: [domain],
        per_page: perPage,
        page: 1,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[apollo] People search error:', JSON.stringify(data));
      return [];
    }
    const people = (data.people ?? []).map(p => ({
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      email: p.email ?? null,
      title: p.title ?? null,
      linkedin_url: p.linkedin_url ?? null,
      phone: p.phone_numbers?.[0]?.sanitized_number ?? null,
    }));
    console.log(`[apollo] People search returned ${people.length} results for ${domain}`);
    return people;
  } catch (err) {
    console.error(`[apollo] People search error for ${domain}:`, err.message);
    return [];
  }
}

/**
 * Reveal a person's email using name + domain.
 * Endpoint: POST /v1/people/match
 */
export async function revealPerson(firstName, lastName, domain) {
  console.log(`[apollo] Reveal: ${firstName} ${lastName} @ ${domain}`);
  try {
    const res = await fetch(`${APOLLO_BASE_URL}/people/match`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        domain,
        reveal_personal_emails: true,
        reveal_phone_number: false,
      }),
    });
    const data = await res.json();
    const email = data.person?.email ?? null;
    const phone = data.person?.phone_numbers?.[0]?.sanitized_number ?? null;
    const linkedin = data.person?.linkedin_url ?? null;
    const title = data.person?.title ?? null;
    console.log(`[apollo] Revealed: email=${email ?? 'none'} | linkedin=${linkedin ?? 'none'}`);
    return { email, phone, linkedin, title };
  } catch (err) {
    console.error(`[apollo] Reveal error for ${firstName} ${lastName}:`, err.message);
    return { email: null, phone: null, linkedin: null, title: null };
  }
}
