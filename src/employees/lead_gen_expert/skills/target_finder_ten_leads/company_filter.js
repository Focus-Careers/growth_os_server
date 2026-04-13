/**
 * Pre-filter Companies House results before sending to Claude for scoring.
 * Eliminates obviously irrelevant companies to save Claude API calls.
 *
 * @param {object} company - CH company data (company_name, date_of_creation, active_officer_count, etc.)
 * @param {object} searchProfile - The search profile with negatives and filters
 * @returns {string|null} - Reason for skipping, or null if company passes filters
 */
export function shouldSkipCompany(company, searchProfile) {
  const name = (company.company_name ?? company.companyName ?? '').toUpperCase();

  // Skip companies with negative keywords in name (word-boundary match to avoid false positives
  // like "IT" matching "LIMITED", "JOINERY", "FACILITY", etc.)
  const negatives = (searchProfile.company_name_negatives ?? []).map(n => n.toUpperCase());
  for (const neg of negatives) {
    const negRegex = new RegExp(`\\b${neg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (negRegex.test(name)) return `name contains "${neg}"`;
  }

  // Skip companies with no active officers
  const officerCount = company.active_officer_count ?? company.officers?.length ?? null;
  if (officerCount === 0) return 'no active officers';

  // Skip very new companies
  const minAge = searchProfile.min_company_age_years ?? 2;
  if (company.date_of_creation || company.dateOfCreation) {
    const dateStr = company.date_of_creation ?? company.dateOfCreation;
    const year = parseInt(dateStr.split('-')[0]);
    if (!isNaN(year)) {
      const age = new Date().getFullYear() - year;
      if (age < minAge) return `too new (${age} years, min ${minAge})`;
    }
  }

  return null; // passes all filters
}
