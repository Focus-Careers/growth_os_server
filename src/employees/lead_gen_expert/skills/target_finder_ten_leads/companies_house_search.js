import { searchCompanies, getCompanyProfile, getCompanyOfficers } from '../../../../config/companies_house.js';
import { mapItpToSicCodes } from './sic_code_mapper.js';
import { resolveDomain } from './domain_resolver.js';

/**
 * Parse a CH officer name into first/last name.
 * CH stores names as "SURNAME, Firstname Middlename" (all caps surname).
 */
function parseOfficerName(name) {
  if (!name) return { first_name: null, last_name: null };

  // CH format: "SURNAME, Firstname" or just "Firstname Surname"
  if (name.includes(',')) {
    const [surname, rest] = name.split(',').map(s => s.trim());
    const firstName = rest?.split(' ')[0] ?? null;
    return {
      first_name: firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase() : null,
      last_name: surname.charAt(0).toUpperCase() + surname.slice(1).toLowerCase(),
    };
  }

  const parts = name.split(' ');
  return {
    first_name: parts[0] ?? null,
    last_name: parts.slice(1).join(' ') || null,
  };
}

/**
 * Extract a usable location string from a CH registered address.
 */
function extractLocation(address) {
  if (!address) return null;
  const parts = [address.locality, address.region, address.postal_code].filter(Boolean);
  return parts.join(', ') || null;
}

/**
 * Map SIC code to human-readable description.
 * Returns the code itself if no mapping found (Claude scoring can still use it).
 */
const SIC_DESCRIPTIONS = {
  '41100': 'Development of building projects',
  '41201': 'Construction of commercial buildings',
  '41202': 'Construction of domestic buildings',
  '42110': 'Construction of roads and motorways',
  '42210': 'Construction of utility projects for fluids',
  '42990': 'Construction of other civil engineering projects',
  '43110': 'Demolition',
  '43120': 'Site preparation',
  '43210': 'Electrical installation',
  '43220': 'Plumbing, heat and air-conditioning installation',
  '43290': 'Other construction installation',
  '43310': 'Plastering',
  '43320': 'Joinery installation',
  '43330': 'Floor and wall covering',
  '43341': 'Painting',
  '43342': 'Glazing',
  '43390': 'Other building completion and finishing',
  '43910': 'Roofing activities',
  '43991': 'Scaffold erection',
  '43999': 'Other specialised construction activities n.e.c.',
};

function describeSicCode(code) {
  return SIC_DESCRIPTIONS[code] ?? `SIC ${code}`;
}

/**
 * Search Companies House for companies matching an ITP.
 * Returns structured results ready for scoring.
 *
 * @param {{ itp: object, existingDomains: Set, existingCHNumbers: Set, customerDomains: Set, onProgress?: (processed: number, total: number) => void }} opts
 * @returns {Promise<Array>} Array of company result objects
 */
export async function searchCompaniesHouseForItp({ itp, existingDomains, existingCHNumbers, customerDomains, onProgress }) {
  const sicCodes = await mapItpToSicCodes(itp);
  if (sicCodes.length === 0) {
    console.log('[ch_search] No SIC codes mapped, skipping Companies House search');
    return [];
  }

  console.log(`[ch_search] Searching CH with SIC codes: ${sicCodes.join(', ')} | location: ${itp.location ?? 'UK'}`);

  // "Anywhere in the UK" means no location filter — don't pass it to CH or it returns 404
  const locationParam = (itp.location && itp.location.toLowerCase() !== 'anywhere in the uk')
    ? itp.location
    : undefined;

  const searchResult = await searchCompanies({
    sicCodes,
    location: locationParam,
  });

  const items = searchResult.items ?? [];
  console.log(`[ch_search] Processing ${items.length} CH results`);

  const results = [];

  let processed = 0;
  for (const item of items) {
    processed++;
    if (onProgress) onProgress(processed, items.length);

    const companyNumber = item.company_number;
    if (!companyNumber) continue;

    // Dedup by CH number
    if (existingCHNumbers.has(companyNumber)) {
      console.log(`[ch_search] Skipping ${companyNumber} (already exists)`);
      continue;
    }

    // Fetch profile + officers
    const [profile, officers] = await Promise.all([
      getCompanyProfile(companyNumber),
      getCompanyOfficers(companyNumber),
    ]);

    if (!profile) continue;

    // Extract or resolve domain
    let domain = null;
    // CH doesn't have a standard website field, but some profiles have it in links
    // The profile may have company_name and registered_office_address
    const companyName = profile.company_name ?? item.company_name;
    const location = extractLocation(profile.registered_office_address);

    // Try to resolve domain
    domain = await resolveDomain(companyName, location);

    // Dedup by domain (if resolved)
    if (domain) {
      if (existingDomains.has(domain) || customerDomains.has(domain)) {
        console.log(`[ch_search] Skipping ${companyName} — domain ${domain} already exists`);
        continue;
      }
    }

    // Parse officers
    const parsedOfficers = officers.map(o => ({
      ...parseOfficerName(o.name),
      role: o.officer_role ?? null,
      appointed_on: o.appointed_on ?? null,
    }));

    // Build SIC description
    const companySicCodes = profile.sic_codes ?? [];
    const sicDescription = companySicCodes.map(describeSicCode).join(', ') || 'Unknown';

    results.push({
      companyName,
      companyNumber,
      domain,
      link: domain ? `https://${domain}` : null,
      location,
      sicCodes: companySicCodes,
      sicDescription,
      dateOfCreation: profile.date_of_creation ?? null,
      companyType: profile.type ?? null,
      officers: parsedOfficers,
    });

    console.log(`[ch_search] Found: ${companyName} (${companyNumber}) → ${domain ?? 'no domain'} | ${parsedOfficers.length} officers`);
  }

  console.log(`[ch_search] Returning ${results.length} new companies from Companies House`);
  return results;
}
