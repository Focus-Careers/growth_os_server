import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { enrichCompany, revealPerson } from '../../../../config/apollo.js';
import { scrapeWebsite } from '../../../../config/scraper.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  // ── Step 4: Apollo People Reveal ───────────────────────────────────
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
