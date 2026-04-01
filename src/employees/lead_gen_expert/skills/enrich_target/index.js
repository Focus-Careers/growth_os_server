import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { enrichCompany, revealPerson, searchPeopleAtCompany } from '../../../../config/apollo.js';
import { scrapeWebsite } from '../../../../config/scraper.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DUMMY_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',
  'test.com', 'test.org', 'testing.com',
  'sample.com', 'email.com',
  'mailinator.com', 'guerrillamail.com', 'tempmail.com',
  'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'spam4.me',
  'placeholder.com', 'dummy.com', 'noemail.com',
]);

const DUMMY_EMAIL_LOCALS = new Set([
  'sample', 'test', 'placeholder', 'dummy', 'fake',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'example', 'user', 'email', 'mail', 'none',
]);

const DUMMY_FULL_NAMES = new Set([
  'john doe', 'jane doe', 'john smith', 'jane smith',
  'sample user', 'test user', 'first last', 'full name',
  'your name', 'contact name', 'person name', 'first name last name',
]);

function isDummyContact(email, firstName, lastName) {
  if (!email) return false;
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return false;
  if (DUMMY_EMAIL_DOMAINS.has(domain)) return true;
  if (DUMMY_EMAIL_LOCALS.has(local)) return true;
  const fullName = `${(firstName ?? '').trim()} ${(lastName ?? '').trim()}`.toLowerCase().trim();
  if (fullName && DUMMY_FULL_NAMES.has(fullName)) return true;
  return false;
}

/**
 * Enriches a target (company) with data from Apollo, website scraping, and Claude extraction.
 *
 * @param {object} params
 * @param {string} params.target_id - The target to enrich
 * @param {string} params.user_details_id - For logging
 * @param {boolean} [params.silent=false] - Skip processSkillOutput
 */
export async function executeSkill({ target_id, user_details_id, silent = true }) {
  const admin = getSupabaseAdmin();

  // Load target
  const { data: target } = await admin
    .from('targets').select('id, domain, title, link, enriched_at').eq('id', target_id).single();

  if (!target) throw new Error(`Target not found: ${target_id}`);

  // Skip if already enriched (avoid re-enriching on duplicate calls)
  if (target.enriched_at) {
    console.log(`[enrich_target] ${target.domain} already enriched, skipping`);
    return { target_id, contacts: [], already_enriched: true };
  }

  const domain = target.domain;
  if (!domain) {
    console.error(`[enrich_target] No domain for target ${target_id}`);
    return { target_id, contacts: [], error: 'no_domain' };
  }

  console.log(`[enrich_target] Starting enrichment for ${domain}`);

  // Get the ITP demographic for context (via any lead for this target)
  const { data: leadRow } = await admin
    .from('leads').select('itp_id').eq('target_id', target_id).limit(1).single();
  let itpDemographic = null;
  if (leadRow?.itp_id) {
    const { data: itp } = await admin.from('itp').select('itp_demographic').eq('id', leadRow.itp_id).single();
    itpDemographic = itp?.itp_demographic;
  }

  // ── Step 1: Apollo Company Enrichment ──────────────────────────────
  const apolloCompany = await enrichCompany(domain);

  const enrichmentUpdate = {
    enrichment_source: 'apollo',
    enriched_at: new Date().toISOString(),
  };
  if (apolloCompany) {
    if (apolloCompany.short_description) enrichmentUpdate.company_description = apolloCompany.short_description;
    if (apolloCompany.industry) enrichmentUpdate.industry = apolloCompany.industry;
    if (apolloCompany.estimated_num_employees) enrichmentUpdate.employee_count = apolloCompany.estimated_num_employees;
    if (apolloCompany.phone) enrichmentUpdate.company_phone = apolloCompany.phone;
    if (apolloCompany.linkedin_url) enrichmentUpdate.company_linkedin = apolloCompany.linkedin_url;
    if (apolloCompany.city || apolloCompany.country) {
      enrichmentUpdate.company_location = [apolloCompany.city, apolloCompany.state, apolloCompany.country].filter(Boolean).join(', ');
    }
  }

  // Save company enrichment data to targets table
  await admin.from('targets').update(enrichmentUpdate).eq('id', target_id);
  console.log(`[enrich_target] Apollo company data saved for ${domain}`);

  // ── Step 2: Website Scrape ─────────────────────────────────────────
  const scrapeResult = await scrapeWebsite(domain);
  console.log(`[enrich_target] Scraped ${scrapeResult.pagesScraped} pages, found ${scrapeResult.emails.length} emails in HTML`);

  // ── Step 3: Claude Extraction ──────────────────────────────────────
  let extractedPeople = [];
  if (scrapeResult.text.length > 200) {
    try {
      const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');
      const response = await getAnthropic().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `${prompt}\n\nDomain: ${domain}\nCompany name: ${target.title ?? 'Unknown'}\n\nWebsite content:\n${scrapeResult.text.slice(0, 8000)}`,
        }],
      });

      const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      try {
        extractedPeople = JSON.parse(raw);
        if (!Array.isArray(extractedPeople)) extractedPeople = [];
      } catch {
        console.error('[enrich_target] Failed to parse Claude extraction:', raw.slice(0, 200));
        extractedPeople = [];
      }
      console.log(`[enrich_target] Claude extracted ${extractedPeople.length} people from website`);
    } catch (err) {
      console.error('[enrich_target] Claude extraction error:', err.message);
    }
  }

  // Merge emails found directly in HTML with Claude-extracted people
  // Add any HTML emails that Claude didn't find as "unknown" contacts
  const claudeEmails = new Set(extractedPeople.map(p => p.email?.toLowerCase()).filter(Boolean));
  for (const htmlEmail of scrapeResult.emails) {
    if (!claudeEmails.has(htmlEmail)) {
      extractedPeople.push({ first_name: null, last_name: null, email: htmlEmail, role: null, source: 'website_html' });
    }
  }

  // ── Step 4: Apollo People Search ────────────────────────────────────
  // Find additional contacts at this company that aren't on the website
  const apolloPeople = await searchPeopleAtCompany(domain);
  const existingNames = new Set(
    extractedPeople
      .filter(p => p.first_name && p.last_name)
      .map(p => `${p.first_name.toLowerCase()} ${p.last_name.toLowerCase()}`)
  );
  for (const ap of apolloPeople) {
    const nameKey = `${(ap.first_name ?? '').toLowerCase()} ${(ap.last_name ?? '').toLowerCase()}`.trim();
    if (nameKey && !existingNames.has(nameKey)) {
      extractedPeople.push({
        first_name: ap.first_name,
        last_name: ap.last_name,
        email: ap.email,
        role: ap.title,
        phone: ap.phone,
        linkedin: ap.linkedin_url,
        source: 'apollo_search',
      });
      existingNames.add(nameKey);
    }
  }
  console.log(`[enrich_target] Apollo people search added ${apolloPeople.length > 0 ? apolloPeople.length : 0} people for ${domain}`);

  // ── Step 5: Load CH officer contacts for Apollo reveal ─────────────
  // CH officers were saved with names but no emails — try to reveal them
  const { data: chOfficers } = await admin
    .from('contacts')
    .select('id, first_name, last_name, email, role')
    .eq('target_id', target_id)
    .eq('source', 'companies_house');

  for (const officer of (chOfficers ?? [])) {
    if (officer.email) continue; // Already has email
    const nameKey = `${(officer.first_name ?? '').toLowerCase()} ${(officer.last_name ?? '').toLowerCase()}`.trim();
    if (!nameKey || existingNames.has(nameKey)) continue;
    // Add to extractedPeople so they go through Apollo reveal below
    extractedPeople.push({
      first_name: officer.first_name,
      last_name: officer.last_name,
      email: null,
      role: officer.role,
      source: 'companies_house',
      _existingContactId: officer.id, // Flag to update existing record instead of inserting
    });
    existingNames.add(nameKey);
  }

  // ── Step 6: Apollo People Reveal ───────────────────────────────────
  const savedContacts = [];

  for (const person of extractedPeople) {
    let email = person.email ?? null;
    let phone = person.phone ?? null;
    let linkedin = person.linkedin ?? null;
    let role = person.role ?? null;
    let source = person.source ?? 'website_scrape';

    // If we have a full name but no email, try Apollo reveal
    if (!email && person.first_name && person.last_name) {
      const revealed = await revealPerson(person.first_name, person.last_name, domain);
      if (revealed.email) {
        email = revealed.email;
        source = 'apollo_reveal';
      }
      if (revealed.phone && !phone) phone = revealed.phone;
      if (revealed.linkedin && !linkedin) linkedin = revealed.linkedin;
      if (revealed.title && !role) role = revealed.title;
    }

    // Skip if still no email
    if (!email) {
      console.log(`[enrich_target] No email for ${person.first_name ?? 'unknown'} ${person.last_name ?? ''} — skipping`);
      continue;
    }

    // Skip dummy/placeholder contacts
    if (isDummyContact(email, person.first_name, person.last_name)) {
      console.log(`[enrich_target] Skipping dummy contact: ${person.first_name ?? ''} ${person.last_name ?? ''} <${email}>`);
      continue;
    }

    // If this is a CH officer we're updating with a revealed email
    if (person._existingContactId && email) {
      await admin.from('contacts').update({
        email: email.toLowerCase(),
        phone: phone ?? undefined,
        linkedin_url: linkedin ?? undefined,
        role: role ?? undefined,
        source: 'apollo_reveal',
      }).eq('id', person._existingContactId);
      console.log(`[enrich_target] Updated CH officer: ${person.first_name} ${person.last_name} <${email}>`);
      const { data: updated } = await admin.from('contacts').select().eq('id', person._existingContactId).single();
      if (updated) savedContacts.push(updated);
      continue;
    }

    // Dedup check
    const { data: existing } = await admin
      .from('contacts')
      .select('id')
      .eq('target_id', target_id)
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (existing) {
      console.log(`[enrich_target] Contact already exists: ${email}`);
      continue;
    }

    // Get account_id from the lead
    let account_id = null;
    if (leadRow?.itp_id) {
      const { data: itp } = await admin.from('itp').select('account_id').eq('id', leadRow.itp_id).single();
      account_id = itp?.account_id ?? null;
    }

    const { data: contact, error } = await admin
      .from('contacts')
      .insert({
        target_id,
        account_id,
        first_name: person.first_name ?? null,
        last_name: person.last_name ?? null,
        email: email.toLowerCase(),
        role,
        linkedin_url: linkedin,
        phone,
        source,
      })
      .select()
      .single();

    if (error) {
      console.error(`[enrich_target] Contact insert error for ${email}:`, error.message);
    } else {
      console.log(`[enrich_target] Saved: ${person.first_name ?? '?'} ${person.last_name ?? '?'} <${email}> (${source})`);
      savedContacts.push(contact);
    }
  }

  console.log(`[enrich_target] Done — ${savedContacts.length} contacts saved for ${domain}`);

  return { target_id, contacts: savedContacts };
}
