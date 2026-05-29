/**
 * remove_invalid_contacts.mjs
 *
 * Removes contacts marked as 'invalid' by MillionVerifier from both the
 * campaign_contacts and contacts tables.
 *
 * Run AFTER verify_contact_emails.mjs has completed.
 *
 * Usage (from growth_os_server root):
 *   node scripts/remove_invalid_contacts.mjs                        # all invalid contacts
 *   CAMPAIGN_ID=your-uuid node scripts/remove_invalid_contacts.mjs  # single campaign only
 *   DRY_RUN=1 node scripts/remove_invalid_contacts.mjs              # dry run (no writes)
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in the .env file.
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log(`\n🗑️  remove_invalid_contacts — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${CAMPAIGN_ID ? ` — campaign ${CAMPAIGN_ID}` : ' — all contacts'}\n`);

// ── Find invalid contact IDs ──────────────────────────────────────────────────
let invalidContactIds = [];

if (CAMPAIGN_ID) {
  // Only invalid contacts that belong to this campaign
  const { data, error } = await supabase
    .from('campaign_contacts')
    .select('contact_id, contacts(id, email, email_verification_status)')
    .eq('campaign_id', CAMPAIGN_ID);

  if (error) { console.error('Fetch error:', error.message); process.exit(1); }

  invalidContactIds = (data ?? [])
    .filter(row => row.contacts?.email_verification_status === 'invalid')
    .map(row => row.contact_id);
} else {
  // All invalid contacts in the DB
  const { data, error } = await supabase
    .from('contacts')
    .select('id, email')
    .eq('email_verification_status', 'invalid');

  if (error) { console.error('Fetch error:', error.message); process.exit(1); }
  invalidContactIds = (data ?? []).map(c => c.id);
}

if (invalidContactIds.length === 0) {
  console.log('No invalid contacts found. Nothing to do.');
  process.exit(0);
}

console.log(`Found ${invalidContactIds.length} invalid contacts.\n`);

if (DRY_RUN) {
  console.log(`Would delete ${invalidContactIds.length} rows from campaign_contacts.`);
  console.log(`Would delete ${invalidContactIds.length} rows from contacts.`);
  console.log('\nRun without DRY_RUN=1 to apply.');
  process.exit(0);
}

// ── Step 1: Remove from campaign_contacts ─────────────────────────────────────
const { error: ccError, count: ccCount } = await supabase
  .from('campaign_contacts')
  .delete({ count: 'exact' })
  .in('contact_id', invalidContactIds);

if (ccError) {
  console.error('Error deleting from campaign_contacts:', ccError.message);
  process.exit(1);
}
console.log(`✅ Removed ${ccCount ?? '?'} rows from campaign_contacts.`);

// ── Step 2: Remove from contacts ──────────────────────────────────────────────
const { error: cError, count: cCount } = await supabase
  .from('contacts')
  .delete({ count: 'exact' })
  .in('id', invalidContactIds);

if (cError) {
  console.error('Error deleting from contacts:', cError.message);
  process.exit(1);
}
console.log(`✅ Removed ${cCount ?? '?'} rows from contacts.`);

console.log('\nDone.\n');
