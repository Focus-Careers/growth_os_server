/**
 * enrich_target — Phase 3 rewrite
 *
 * Enriches a target with Apollo company data, scraped website content, and
 * contacts built from multiple sources via the contact reconciler.
 *
 * Sources merged by contact_reconciler (in priority order):
 *   website_hypotheses  — extracted by contact_extractor from scraped pages
 *   apollo_people       — free people search at domain
 *   ch_officers         — Companies House officers already saved to DB
 *
 * Apollo reveal (1 credit each) is applied to the top-ranked contacts without
 * emails, up to `apollo_reveals_cap` per target (default 3).
 *
 * Backward-compatible: can be called standalone (no runId) or from the
 * 100_leads orchestrator (with runId + custom caps).
 */

import { scrapeSite } from '../../../../lib/lead_gen/scraper.js';
import { extractContactHypotheses } from '../../../../lib/lead_gen/contact_extractor.js';
import { reconcileContacts } from '../../../../lib/lead_gen/contact_reconciler.js';
import { enrichCompany, searchPeopleAtCompany, revealPerson } from '../../../../config/apollo.js';
import { increment } from '../../../../lib/cost_tracker.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const MAX_CONTACTS_PER_COMPANY = 10;
const DEFAULT_REVEAL_CAP = 5;

// Emails that look like real addresses but are placeholders
const DUMMY_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'test.com', 'testing.com',
  'sample.com', 'email.com', 'mailinator.com', 'guerrillamail.com', 'tempmail.com',
  'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'placeholder.com', 'dummy.com',
]);
const DUMMY_EMAIL_LOCALS = new Set([
  'sample', 'test', 'placeholder', 'dummy', 'fake', 'noreply', 'no-reply',
  'donotreply', 'do-not-reply', 'example', 'user', 'email', 'mail', 'none',
]);
const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,6}$/i;

function isDummyEmail(email) {
  if (!email || !VALID_EMAIL_RE.test(email)) return true;
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return true;
  if (DUMMY_EMAIL_DOMAINS.has(domain)) return true;
  if (DUMMY_EMAIL_LOCALS.has(local)) return true;
  return false;
}

/**
 * @param {object} params
 * @param {string}  params.target_id
 * @param {string}  params.user_details_id         - For logging
 * @param {boolean} [params.silent=true]            - Skip processSkillOutput if true
 * @param {string}  [params.runId]                  - cost_tracker run id (optional)
 * @param {number}  [params.apollo_reveals_cap]     - Max reveal credits per target (default 3)
 *
 * @returns {Promise<{
 *   target_id: string,
 *   contacts: object[],
 *   already_enriched?: boolean,
 *   error?: string,
 * }>}
 */
export async function executeSkill({
  target_id,
  user_details_id,
  silent = true,
  runId = null,
  apollo_reveals_cap = DEFAULT_REVEAL_CAP,
}) {
  const admin = getSupabaseAdmin();

  const { data: target } = await admin
    .from('targets').select('*').eq('id', target_id).single();

  if (!target) throw new Error(`enrich_target: target not found: ${target_id}`);

  if (target.enriched_at) {
    console.log(`[enrich_target] ${target.domain} already enriched — skipping`);
    return { target_id, contacts: [], already_enriched: true };
  }

  const domain = target.domain;
  if (!domain) {
    console.warn(`[enrich_target] No domain for target ${target_id}`);
    return { target_id, contacts: [], error: 'no_domain' };
  }

  console.log(`[enrich_target] Starting enrichment for ${domain}`);

  // Resolve ITP for context (role_relevance scoring in reconciler)
  const { data: leadRow } = await admin
    .from('leads').select('itp_id').eq('target_id', target_id).limit(1).single();
  let itp = null;
  if (leadRow?.itp_id) {
    const { data: itpRow } = await admin.from('itp').select('*').eq('id', leadRow.itp_id).single();
    itp = itpRow;
  }
  const account_id = itp?.account_id ?? null;

  // ── Step 1: Apollo company enrichment (1 credit) ──────────────────────
  let apolloCompany = null;
  try {
    apolloCompany = await enrichCompany(domain);
    await increment(runId, { apollo_credits_used: 1 });
  } catch (err) {
    console.warn(`[enrich_target] Apollo company error for ${domain}:`, err.message);
  }

  // enriched_at is set later, only if we actually find contacts — so targets
  // with zero contacts remain retryable as Apollo's database grows.
  const enrichmentUpdate = { enrichment_source: 'apollo' };
  if (apolloCompany) {
    if (apolloCompany.short_description) enrichmentUpdate.company_description = apolloCompany.short_description;
    if (apolloCompany.industry)          enrichmentUpdate.industry = apolloCompany.industry;
    if (apolloCompany.estimated_num_employees) enrichmentUpdate.employee_count = apolloCompany.estimated_num_employees;
    if (apolloCompany.phone)             enrichmentUpdate.company_phone = apolloCompany.phone;
    if (apolloCompany.linkedin_url)      enrichmentUpdate.company_linkedin = apolloCompany.linkedin_url;
    if (apolloCompany.city || apolloCompany.country) {
      enrichmentUpdate.company_location = [apolloCompany.city, apolloCompany.state, apolloCompany.country]
        .filter(Boolean).join(', ');
    }
  }
  await admin.from('targets').update(enrichmentUpdate).eq('id', target_id);

  // ── Step 2: Website scrape ─────────────────────────────────────────────
  let scraped = { pages_scraped: 0, all_text: '', all_emails: [], blocked: false };
  try {
    scraped = await scrapeSite({ domain, page_set: 'homepage_plus_about_contact' });
    console.log(`[enrich_target] Scraped ${scraped.pages_scraped} pages, ${scraped.all_emails.length} emails for ${domain}`);
  } catch (err) {
    console.warn(`[enrich_target] Scrape error for ${domain}:`, err.message);
  }

  // ── Step 3: Contact hypothesis extraction ─────────────────────────────
  let websiteHypotheses = [];
  try {
    websiteHypotheses = await extractContactHypotheses({
      scraped,
      domain,
      company_name: target.title,
    });
  } catch (err) {
    console.warn(`[enrich_target] Extraction error for ${domain}:`, err.message);
  }

  // ── Step 4: Apollo people search (free) ───────────────────────────────
  let apolloPeople = [];
  try {
    apolloPeople = await searchPeopleAtCompany(domain);
  } catch (err) {
    console.warn(`[enrich_target] Apollo people error for ${domain}:`, err.message);
  }

  // ── Step 5: Load existing CH officer contacts ──────────────────────────
  const { data: chOfficers } = await admin
    .from('contacts')
    .select('id, first_name, last_name, email, role')
    .eq('target_id', target_id)
    .eq('source', 'companies_house');

  // ── Step 6: Reconcile all sources ─────────────────────────────────────
  const { contacts: rankedContacts, fallback_channels } = reconcileContacts({
    website_hypotheses: websiteHypotheses,
    apollo_people: apolloPeople,
    ch_officers: chOfficers ?? [],
    domain,
    itp_context: itp,
  });

  // ── Step 7: Apollo reveal for top contacts without emails ─────────────
  let revealsUsed = 0;
  for (const contact of rankedContacts) {
    if (revealsUsed >= apollo_reveals_cap) break;
    if (contact.email) continue;                           // already has email
    if (!contact.first_name || !contact.last_name) continue; // need full name

    try {
      const revealed = await revealPerson(contact.first_name, contact.last_name, domain);
      if (revealed.email) {
        contact.email    = revealed.email;
        contact.phone    = contact.phone    ?? revealed.phone    ?? null;
        contact.linkedin = contact.linkedin ?? revealed.linkedin ?? null;
        contact.role     = contact.role     ?? revealed.title    ?? null;
        contact.confidence_label = 'verified_named';
        contact.provenance = [
          ...(contact.provenance ?? []),
          { source: 'apollo_reveal', contribution: 'email revealed via /people/match' },
        ];
        revealsUsed++;
        await increment(runId, { apollo_credits_used: 1 });
      }
    } catch (err) {
      console.warn(`[enrich_target] Reveal error for ${contact.first_name} ${contact.last_name}:`, err.message);
    }
  }

  // ── Step 8: Persist contacts ───────────────────────────────────────────
  const savedContacts = [];

  for (const contact of rankedContacts) {
    if (savedContacts.length >= MAX_CONTACTS_PER_COMPANY) break;
    if (!contact.email) continue;
    if (isDummyEmail(contact.email)) {
      console.log(`[enrich_target] Skipping dummy email: ${contact.email}`);
      continue;
    }

    const emailNorm = contact.email.toLowerCase();

    // Check if we're updating an existing CH officer row
    const chMatch = (chOfficers ?? []).find(o =>
      o.first_name?.toLowerCase() === contact.first_name?.toLowerCase() &&
      o.last_name?.toLowerCase()  === contact.last_name?.toLowerCase()  &&
      !o.email
    );

    if (chMatch) {
      const { data: updated } = await admin.from('contacts').update({
        email: emailNorm,
        phone: contact.phone ?? null,
        linkedin_url: contact.linkedin ?? null,
        role: contact.role ?? null,
        source: 'apollo_reveal',
        confidence_label: contact.confidence_label ?? null,
        provenance: contact.provenance ?? null,
        seniority_score: contact.seniority_score ?? null,
        role_relevance_score: contact.role_relevance_score ?? null,
      }).eq('id', chMatch.id).select().single();
      if (updated) {
        savedContacts.push(updated);
        console.log(`[enrich_target] Updated CH officer: ${contact.first_name} ${contact.last_name} <${emailNorm}>`);
      }
      continue;
    }

    // Dedup check
    const { data: existing } = await admin.from('contacts')
      .select('id').eq('target_id', target_id).eq('email', emailNorm).maybeSingle();
    if (existing) continue;

    // Derive legacy source enum from provenance (for backwards compat with old queries)
    const sources = (contact.provenance ?? []).map(p => p.source);
    let source = 'website_scrape';
    if (sources.includes('apollo_reveal'))                             source = 'apollo_reveal';
    else if (sources.includes('apollo_search') && !sources.includes('website')) source = 'apollo_search';
    else if (sources.includes('companies_house') && !sources.includes('website')) source = 'companies_house';
    else if (sources.includes('website'))                              source = 'website_scrape';

    const { data: inserted, error } = await admin.from('contacts').insert({
      target_id,
      account_id,
      first_name: contact.first_name ?? null,
      last_name:  contact.last_name  ?? null,
      email:      emailNorm,
      role:       contact.role       ?? null,
      phone:      contact.phone      ?? null,
      linkedin_url: contact.linkedin ?? null,
      source,
      confidence_label:    contact.confidence_label    ?? null,
      provenance:          contact.provenance          ?? null,
      seniority_score:     contact.seniority_score     ?? null,
      role_relevance_score: contact.role_relevance_score ?? null,
    }).select().single();

    if (error) {
      console.error(`[enrich_target] Insert error for ${emailNorm}:`, error.message);
    } else {
      savedContacts.push(inserted);
      console.log(`[enrich_target] Saved: ${contact.first_name ?? '?'} ${contact.last_name ?? '?'} <${emailNorm}> [${source}]`);
    }
  }

  // Persist generic mailboxes as fallback channels
  for (const channel of fallback_channels) {
    if (savedContacts.length >= MAX_CONTACTS_PER_COMPANY) break;
    if (!channel.email || isDummyEmail(channel.email)) continue;
    const { data: existing } = await admin.from('contacts')
      .select('id').eq('target_id', target_id).eq('email', channel.email).maybeSingle();
    if (!existing) {
      await admin.from('contacts').insert({
        target_id,
        account_id,
        email: channel.email,
        source: 'website_html',
        confidence_label: 'generic_mailbox',
      });
    }
  }

  if (savedContacts.length > 0) {
    await admin.from('targets').update({ enriched_at: new Date().toISOString() }).eq('id', target_id);
  }

  console.log(`[enrich_target] Done — ${savedContacts.length} contacts saved for ${domain}`);
  return { target_id, contacts: savedContacts };
}
