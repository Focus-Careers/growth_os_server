/**
 * verify_contact_emails.mjs
 *
 * One-off backfill: verifies email addresses for contacts that have not
 * yet been through MillionVerifier (email_verification_status IS NULL),
 * excluding contacts sourced from Apollo reveals (already verified by Apollo).
 *
 * Run BEFORE any email campaigns go live.
 *
 * Usage (from growth_os_server root):
 *   node scripts/verify_contact_emails.mjs                        # all unverified contacts
 *   CAMPAIGN_ID=your-uuid node scripts/verify_contact_emails.mjs  # single campaign only
 *   DRY_RUN=1 node scripts/verify_contact_emails.mjs              # dry run (no writes)
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MILLIONVERIFIER_API_KEY
 * in the .env file (loaded automatically).
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env manually ────────────────────────────────────────────────────────
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* rely on real env vars */ }

const DRY_RUN     = process.env.DRY_RUN === '1';
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? null;
const PAGE_SIZE   = 200;
const DELAY_MS    = 250; // stay well under any undocumented rate limits

function getApiKey() {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) throw new Error('MILLIONVERIFIER_API_KEY not set');
  return key;
}

async function verifyEmail(email) {
  try {
    const params = new URLSearchParams({ api: getApiKey(), email });
    const res = await fetch(`https://api.millionverifier.com/api/v3/?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const rawResult  = data.result ?? data.subresult ?? 'unknown';
    const disposable = !!data.disposable;

    if (disposable || rawResult === 'disposable') return 'invalid';
    if (rawResult === 'ok')                        return 'ok';
    if (rawResult === 'catch_all')                 return 'catch_all';
    if (rawResult === 'invalid' || rawResult === 'error') return 'invalid';
    return 'unknown';
  } catch (err) {
    console.warn(`  [mv] Error verifying ${email}: ${err.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log(`\n📧 verify_contact_emails — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${CAMPAIGN_ID ? ` — campaign ${CAMPAIGN_ID}` : ' — all contacts'}\n`);

// ── Fetch contacts ────────────────────────────────────────────────────────────
let allContacts = [];

if (CAMPAIGN_ID) {
  // Fetch contact IDs for this campaign via campaign_contacts join
  let offset = 0;
  while (true) {
    const { data: ccRows, error } = await supabase
      .from('campaign_contacts')
      .select('contacts(id, email, source, email_verification_status)')
      .eq('campaign_id', CAMPAIGN_ID)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) { console.error('Supabase fetch error:', error.message); process.exit(1); }
    if (!ccRows || ccRows.length === 0) break;

    for (const row of ccRows) {
      const c = row.contacts;
      if (!c || !c.email) continue;
      if (c.source === 'apollo_reveal') continue;        // already verified by Apollo
      if (c.email_verification_status !== null) continue; // already done
      allContacts.push({ id: c.id, email: c.email, source: c.source });
    }

    if (ccRows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
} else {
  // All unverified contacts across the whole DB
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, email, source')
      .is('email_verification_status', null)
      .not('source', 'eq', 'apollo_reveal')
      .not('email', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) { console.error('Supabase fetch error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    allContacts.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

// Deduplicate by contact ID (a contact could appear in multiple campaigns)
const seen = new Set();
allContacts = allContacts.filter(c => {
  if (seen.has(c.id)) return false;
  seen.add(c.id);
  return true;
});

console.log(`Found ${allContacts.length} contacts to verify.\n`);
if (allContacts.length === 0) { console.log('Nothing to do.'); process.exit(0); }

// ── Verify ────────────────────────────────────────────────────────────────────
let ok = 0, catchAll = 0, unknown = 0, invalid = 0, failed = 0;

for (let i = 0; i < allContacts.length; i++) {
  const contact = allContacts[i];
  process.stdout.write(`[${i + 1}/${allContacts.length}] ${contact.email} … `);

  const status = await verifyEmail(contact.email);

  if (!status) {
    console.log('skipped (API error)');
    failed++;
    await new Promise(r => setTimeout(r, DELAY_MS));
    continue;
  }

  if (DRY_RUN) {
    console.log(`would set → ${status}`);
  } else {
    const { error } = await supabase
      .from('contacts')
      .update({ email_verification_status: status })
      .eq('id', contact.id);

    if (error) {
      console.log(`FAILED to save: ${error.message}`);
      failed++;
    } else {
      console.log(status);
    }
  }

  if (status === 'ok')             ok++;
  else if (status === 'catch_all') catchAll++;
  else if (status === 'unknown')   unknown++;
  else if (status === 'invalid')   invalid++;

  await new Promise(r => setTimeout(r, DELAY_MS));
}

console.log(`
✅ Done
  ok:        ${ok}
  catch_all: ${catchAll}
  unknown:   ${unknown}
  invalid:   ${invalid}
  errors:    ${failed}
`);

if (invalid > 0 && !DRY_RUN) {
  console.log(`ℹ️  ${invalid} contacts marked invalid — these will be excluded from future Smartlead pushes automatically.`);
}
