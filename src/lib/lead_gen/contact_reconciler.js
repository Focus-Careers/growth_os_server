/**
 * Contact Reconciler
 *
 * Merges website hypotheses, Apollo people-search results, and Companies House officers
 * into a single ranked, deduplicated list of contacts.
 *
 * Key design decisions:
 *  - Fuzzy name matching for deduplication (Andy ≈ Andrew ≈ A. Patterson)
 *  - When name match is ambiguous: treat as DIFFERENT people (don't merge incorrectly)
 *  - Generic mailboxes (info@, hello@, etc.) are separated as fallback_channels, never contacts
 *  - Each contact carries full provenance (all sources that confirmed them)
 *  - Contacts are ranked by confidence × seniority × role_relevance
 *
 * Email verifier: DEFERRED — see lead_gen_v3_investigation.md
 * TODO: Add email_verifier.js call here before final ranking once implemented.
 */

import { CONFIDENCE } from './contact_extractor.js';

// Common nickname mappings for fuzzy first-name matching
const NICKNAME_MAP = {
  andy: 'andrew', drew: 'andrew',
  bob: 'robert', rob: 'robert', robbie: 'robert',
  bill: 'william', will: 'william', billy: 'william',
  dave: 'david',
  mike: 'michael', mick: 'michael',
  nick: 'nicholas',
  chris: 'christopher',
  dan: 'daniel',
  jim: 'james', jimmy: 'james', jamie: 'james',
  tom: 'thomas', tommy: 'thomas',
  sue: 'susan', susie: 'susan',
  liz: 'elizabeth', beth: 'elizabeth', lisa: 'elizabeth',
  kate: 'katherine', katy: 'katherine', katie: 'katherine', kathy: 'katherine',
  jen: 'jennifer', jenny: 'jennifer',
  sam: 'samuel', // also Samantha — accept the ambiguity
  matt: 'matthew',
  jon: 'jonathan',
  ben: 'benjamin',
  alex: 'alexander', // also Alexandra
  steve: 'stephen',
  tony: 'anthony',
  phil: 'philip',
  pat: 'patrick', // also Patricia
};

const GENERIC_MAILBOX_PREFIXES = new Set([
  'info', 'hello', 'hi', 'sales', 'enquiries', 'enquiry', 'contact', 'contacts',
  'admin', 'administration', 'office', 'mail', 'email', 'support', 'help',
  'accounts', 'billing', 'invoice', 'invoices', 'general', 'team', 'news',
  'marketing', 'hr', 'recruitment', 'jobs', 'careers', 'press', 'media',
  'webmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'postmaster', 'abuse', 'spam', 'feedback', 'enquire',
]);

// Seniority signals — ordered from highest to lowest
const SENIORITY_PATTERNS = [
  { re: /\b(founder|co-?founder|owner|proprietor|principal)\b/i, score: 100 },
  { re: /\b(ceo|chief executive|managing director|md)\b/i, score: 95 },
  { re: /\b(coo|cfo|cto|cmo|chief\s+\w+\s+officer)\b/i, score: 90 },
  { re: /\b(director)\b/i, score: 80 },
  { re: /\b(head of|vp |vice president|general manager)\b/i, score: 75 },
  { re: /\b(manager|lead|senior)\b/i, score: 60 },
  { re: /\b(officer|executive|specialist|advisor|consultant)\b/i, score: 50 },
  { re: /\b(engineer|technician|coordinator|analyst)\b/i, score: 40 },
];

// Confidence weights for ranking
const CONFIDENCE_WEIGHT = {
  [CONFIDENCE.VERIFIED_NAMED]: 100,
  [CONFIDENCE.NAMED_NO_EMAIL]: 70,
  [CONFIDENCE.WEAK_EXTRACTION]: 30,
  apollo_verified: 85,      // Apollo search result with email
  apollo_no_email: 50,      // Apollo search result without email
  ch_officer: 60,           // Companies House officer
};

/**
 * @param {object} params
 * @param {Array}  params.website_hypotheses  - From contact_extractor
 * @param {Array}  params.apollo_people       - From searchPeopleAtCompany
 * @param {Array}  params.ch_officers         - From ch_matcher or existing DB records
 * @param {string} params.domain
 * @param {object} [params.itp_context]       - ITP for role relevance scoring
 *
 * @returns {{
 *   contacts: Array<{
 *     first_name, last_name, email, role, phone, linkedin,
 *     confidence_label, provenance, seniority_score, role_relevance_score, ranking_score
 *   }>,
 *   fallback_channels: Array<{email, source_page}>
 * }}
 */
export function reconcileContacts({
  website_hypotheses = [],
  apollo_people = [],
  ch_officers = [],
  domain,
  itp_context = null,
}) {
  const fallback_channels = [];
  const pool = []; // unified person pool before dedup

  // --- 1. Seed pool from website hypotheses ---
  for (const h of website_hypotheses) {
    if (h.confidence_label === CONFIDENCE.GENERIC_MAILBOX) {
      if (h.email) fallback_channels.push({ email: h.email, source_page: h.source_page });
      continue;
    }
    if (isGenericEmail(h.email)) {
      if (h.email) fallback_channels.push({ email: h.email, source_page: h.source_page });
      continue;
    }
    pool.push({
      first_name: h.first_name,
      last_name: h.last_name,
      email: h.email,
      role: h.role,
      phone: h.phone,
      linkedin: h.linkedin,
      confidence_label: h.confidence_label,
      provenance: [{
        source: 'website',
        contribution: h.evidence_snippet ?? h.source_page ?? 'website content',
      }],
    });
  }

  // --- 2. Merge Apollo people ---
  for (const ap of apollo_people) {
    if (!ap.first_name && !ap.last_name) continue;
    if (isGenericEmail(ap.email)) continue;

    const existing = findMatch(pool, ap.first_name, ap.last_name);
    if (existing) {
      // Merge: Apollo can contribute email, phone, linkedin if not already present
      if (ap.email && !existing.email) existing.email = ap.email;
      if (ap.phone && !existing.phone) existing.phone = ap.phone;
      if (ap.linkedin_url && !existing.linkedin) existing.linkedin = ap.linkedin_url;
      if (!existing.role && ap.title) existing.role = ap.title;
      existing.provenance.push({ source: 'apollo_search', contribution: 'name + title confirmation' });
      // Upgrade confidence if Apollo provides a real email
      if (ap.email && existing.confidence_label !== CONFIDENCE.VERIFIED_NAMED) {
        existing.confidence_label = CONFIDENCE.VERIFIED_NAMED;
      }
    } else {
      const confLabel = ap.email ? CONFIDENCE.VERIFIED_NAMED : CONFIDENCE.NAMED_NO_EMAIL;
      pool.push({
        first_name: ap.first_name,
        last_name: ap.last_name,
        email: ap.email ?? null,
        role: ap.title ?? null,
        phone: ap.phone ?? null,
        linkedin: ap.linkedin_url ?? null,
        confidence_label: confLabel,
        provenance: [{ source: 'apollo_search', contribution: 'Apollo people search result' }],
      });
    }
  }

  // --- 3. Merge CH officers ---
  for (const officer of ch_officers) {
    if (!officer.first_name && !officer.last_name) continue;

    const existing = findMatch(pool, officer.first_name, officer.last_name);
    if (existing) {
      existing.provenance.push({ source: 'companies_house', contribution: `CH officer: ${officer.role ?? 'unknown role'}` });
      if (!existing.role && officer.role) existing.role = officer.role;
    } else {
      pool.push({
        first_name: officer.first_name,
        last_name: officer.last_name,
        email: officer.email ?? null,
        role: officer.role ?? null,
        phone: null,
        linkedin: null,
        confidence_label: CONFIDENCE.NAMED_NO_EMAIL,
        provenance: [{ source: 'companies_house', contribution: `CH officer: ${officer.role ?? 'unknown role'}` }],
      });
    }
  }

  // --- 4. Score and rank ---
  const scored = pool.map(person => {
    const seniority_score = computeSeniorityScore(person.role);
    const role_relevance_score = computeRoleRelevance(person.role, itp_context);
    const conf_weight = CONFIDENCE_WEIGHT[person.confidence_label] ?? 30;

    const ranking_score = Math.round(
      (conf_weight * 0.5) + (seniority_score * 0.35) + (role_relevance_score * 0.15)
    );

    return { ...person, seniority_score, role_relevance_score, ranking_score };
  });

  // Sort descending by ranking_score
  scored.sort((a, b) => b.ranking_score - a.ranking_score);

  // Deduplicate fallback channels
  const uniqueChannels = [];
  const seenEmails = new Set();
  for (const ch of fallback_channels) {
    if (!seenEmails.has(ch.email)) {
      seenEmails.add(ch.email);
      uniqueChannels.push(ch);
    }
  }

  return { contacts: scored, fallback_channels: uniqueChannels };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normaliseName(name) {
  if (!name) return '';
  const lower = name.toLowerCase().trim();
  return NICKNAME_MAP[lower] ?? lower;
}

function isInitialOnly(name) {
  return name?.length === 1 || /^[a-z]\.?$/.test(name?.trim()?.toLowerCase() ?? '');
}

/**
 * Find an existing pool entry that likely represents the same person.
 * Returns the pool entry to mutate, or null if no match.
 * Conservative: if uncertain, returns null (treat as different person).
 */
function findMatch(pool, firstName, lastName) {
  if (!lastName) return null;

  const normLast = normaliseName(lastName);
  const normFirst = normaliseName(firstName);
  const isInitial = isInitialOnly(firstName);

  for (const entry of pool) {
    const entryLast = normaliseName(entry.last_name);
    if (entryLast !== normLast) continue; // last name must match

    const entryFirst = normaliseName(entry.first_name);
    const entryIsInitial = isInitialOnly(entry.first_name);

    // Exact first name match (after nickname normalisation)
    if (normFirst && entryFirst && normFirst === entryFirst) return entry;

    // One side is initial only — match if initial matches first char of full name
    if (isInitial && entryFirst && normFirst === entryFirst[0]) return entry;
    if (entryIsInitial && normFirst && entryFirst === normFirst[0]) return entry;

    // Both have full first names that differ — do NOT merge
  }

  return null;
}

function computeSeniorityScore(role) {
  if (!role) return 20;
  for (const { re, score } of SENIORITY_PATTERNS) {
    if (re.test(role)) return score;
  }
  return 20;
}

function computeRoleRelevance(role, itp_context) {
  if (!role || !itp_context) return 50; // default neutral
  const roleLower = role.toLowerCase();
  // Decision-maker roles are most relevant for B2B outreach
  if (/owner|founder|director|managing|ceo|coo|cfo/.test(roleLower)) return 90;
  if (/manager|head|lead|operations|commercial|business development/.test(roleLower)) return 70;
  if (/accounts|finance|procurement|purchasing/.test(roleLower)) return 60;
  return 40;
}

function isGenericEmail(email) {
  if (!email) return false;
  const local = email.toLowerCase().split('@')[0];
  return GENERIC_MAILBOX_PREFIXES.has(local);
}
