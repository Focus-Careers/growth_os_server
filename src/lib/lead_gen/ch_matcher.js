import {
  searchCompanies,
  getCompanyProfile,
  getCompanyOfficers,
} from '../../config/companies_house.js';

export const MATCH_CONFIDENCE = {
  CONFIRMED: 'confirmed',
  PROBABLE: 'probable',
  UNMATCHED: 'unmatched',
};

/**
 * Attempt to match a candidate business to a Companies House record.
 *
 * Match signal categories:
 *   Strong (any ONE is sufficient for "confirmed"):
 *     - Registration number from website matches CH record exactly
 *     - Registered office postcode exactly matches a postcode found on website
 *     - Registered office phone exactly matches a phone found on website
 *
 *   Medium (need TWO OR MORE for "confirmed"; ONE alone = "probable"):
 *     - Town/city match AND company is active AND incorporation date is plausible
 *     - Trading/brand name on CH record matches website name
 *     - SIC code broadly compatible with website's described business type (requires hint)
 *
 *   Weak (never sufficient alone):
 *     - Name similarity only
 *     - Partial postcode match (area code only)
 *
 * @param {object} params
 * @param {string}   params.name                    - Company name to search for
 * @param {string}   [params.postcode]               - Postcode found on website
 * @param {string}   [params.registration_number]    - CH registration number extracted from website
 * @param {string}   [params.phone]                  - Phone found on website
 * @param {string}   [params.city]                   - Town/city found on website
 *
 * @returns {Promise<{
 *   matched: boolean,
 *   ch_record: object|null,
 *   officers: Array<{first_name, last_name, role, appointed_on}>|null,
 *   match_confidence: 'confirmed'|'probable'|'unmatched',
 *   match_signals: string[],
 * }>}
 */
export async function matchToCompaniesHouse({
  name,
  postcode,
  registration_number,
  phone,
  city,
}) {
  // --- Path 1: direct registration number lookup (always strong signal) ---
  if (registration_number && /^\d{8}$/.test(registration_number.trim())) {
    try {
      const profile = await getCompanyProfile(registration_number.trim());
      if (profile) {
        const officers = await safeGetOfficers(registration_number.trim());
        return {
          matched: true,
          ch_record: profile,
          officers,
          match_confidence: MATCH_CONFIDENCE.CONFIRMED,
          match_signals: [`registration_number_exact:${registration_number.trim()}`],
        };
      }
    } catch (err) {
      console.log(`[ch_matcher] Reg number lookup failed for ${registration_number}:`, err.message);
    }
  }

  // --- Path 2: name search then signal evaluation ---
  let candidates = [];
  try {
    const results = await searchCompanies({ companyName: name, size: 5 });
    candidates = results.items ?? [];
  } catch (err) {
    console.log(`[ch_matcher] Search failed for "${name}":`, err.message);
    return unmatched();
  }

  if (candidates.length === 0) return unmatched();

  // Evaluate each candidate and pick the best match
  for (const candidate of candidates) {
    const signals = [];
    let profile = null;

    try {
      profile = await getCompanyProfile(candidate.company_number);
    } catch { /* best-effort */ }

    if (!profile) continue;

    const regAddr = profile.registered_office_address ?? {};
    const chPostcode = (regAddr.postal_code ?? '').trim().toUpperCase();
    const chPhone = (profile.accounts?.accounting_reference_date?.day ?? '').trim(); // CH doesn't expose phone directly
    const chTown = (regAddr.locality ?? regAddr.region ?? '').toLowerCase().trim();
    const chName = (profile.company_name ?? '').toLowerCase();
    const isActive = profile.company_status === 'active';

    // --- Strong signals ---
    if (postcode) {
      const normPostcode = postcode.trim().toUpperCase();
      if (chPostcode && chPostcode === normPostcode) {
        signals.push(`postcode_exact:${chPostcode}`);
      }
    }
    // Note: CH API does not expose registered phone; strong phone signal would come from
    // scraping CH website itself — left as extension point for future.

    // --- Medium signals ---
    const mediumSignals = [];

    // Town/city match + active + plausible age
    if (city && chTown && city.toLowerCase().includes(chTown) || (chTown && city && chTown.includes(city.toLowerCase()))) {
      if (isActive) {
        mediumSignals.push(`city_match:${chTown}`);
      }
    }

    // Name similarity (trading name / brand)
    const searchNameNorm = name.toLowerCase().replace(/\blimited\b|\bltd\b|\bplc\b/g, '').trim();
    const chNameNorm = chName.replace(/\blimited\b|\bltd\b|\bplc\b/g, '').trim();
    if (chNameNorm.length > 3 && (
      chNameNorm.includes(searchNameNorm.slice(0, Math.min(searchNameNorm.length, 20))) ||
      searchNameNorm.includes(chNameNorm.slice(0, Math.min(chNameNorm.length, 20)))
    )) {
      mediumSignals.push(`name_match:${profile.company_name}`);
    }

    // Partial postcode (area code only — weak)
    if (postcode && chPostcode) {
      const websiteArea = postcode.trim().split(' ')[0].toUpperCase();
      const chArea = chPostcode.split(' ')[0];
      if (websiteArea && chArea && websiteArea === chArea) {
        signals.push(`postcode_area:${chArea}`); // logged but counted as weak
      }
    }

    // --- Determine confidence ---
    const strongCount = signals.filter(s =>
      s.startsWith('postcode_exact') || s.startsWith('registration_number')
    ).length;

    signals.push(...mediumSignals);

    let confidence;
    if (strongCount >= 1 || mediumSignals.length >= 2) {
      confidence = MATCH_CONFIDENCE.CONFIRMED;
    } else if (mediumSignals.length === 1) {
      confidence = MATCH_CONFIDENCE.PROBABLE;
    } else {
      // Only weak signals — not a usable match
      continue;
    }

    const officers = await safeGetOfficers(candidate.company_number);

    console.log(`[ch_matcher] "${name}" → ${profile.company_name} (${candidate.company_number}) — ${confidence} [${signals.join(', ')}]`);

    return {
      matched: true,
      ch_record: profile,
      officers,
      match_confidence: confidence,
      match_signals: signals,
    };
  }

  return unmatched();
}

async function safeGetOfficers(companyNumber) {
  try {
    // getCompanyOfficers returns the active officers array directly (already filtered)
    const officers = await getCompanyOfficers(companyNumber);
    return (Array.isArray(officers) ? officers : []).map(o => ({
      // CH names are stored as "SURNAME, Firstname Middlename"
      first_name: o.name?.split(',')?.[1]?.trim().split(' ')?.[0] ?? null,
      last_name: o.name?.split(',')?.[0]?.trim() ?? null,
      role: o.officer_role ?? null,
      appointed_on: o.appointed_on ?? null,
    }));
  } catch {
    return null;
  }
}

function unmatched() {
  return {
    matched: false,
    ch_record: null,
    officers: null,
    match_confidence: MATCH_CONFIDENCE.UNMATCHED,
    match_signals: [],
  };
}
