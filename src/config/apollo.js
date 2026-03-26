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
