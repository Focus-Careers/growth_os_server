/**
 * backfill_ch_data.mjs
 *
 * One-off script: for every target that has a companies_house_number but is
 * missing sic_codes / company_status / incorporated_at, fetch the CH profile
 * and fill in the gaps.
 *
 * Usage (from the growth_os_server root):
 *   node scripts/backfill_ch_data.mjs
 *
 * Dry-run (prints what it would do, no writes):
 *   DRY_RUN=1 node scripts/backfill_ch_data.mjs
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPANIES_HOUSE_API_KEY
 * in the .env file (loaded automatically).
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env manually (no dotenv dependency needed) ──────────────────────────
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
} catch { /* .env not present — rely on real env vars */ }

const DRY_RUN = process.env.DRY_RUN === '1';
const PAGE_SIZE = 200;
const CH_BASE_URL = 'https://api.company-information.service.gov.uk';

// CH rate-limit: 600 req / 5 min → 1 per 200 ms for headroom
const QUEUE_INTERVAL_MS = 220;
let queueTail = Promise.resolve();
function enqueue(fn) {
  const result = queueTail.then(() => fn());
  queueTail = result
    .then(() => new Promise(r => setTimeout(r, QUEUE_INTERVAL_MS)))
    .catch(() => new Promise(r => setTimeout(r, QUEUE_INTERVAL_MS)));
  return result;
}

function getAuthHeader() {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function getCompanyProfile(companyNumber) {
  return enqueue(async () => {
    try {
      const res = await fetch(`${CH_BASE_URL}/company/${companyNumber}`, {
        headers: { Authorization: getAuthHeader() },
      });
      if (!res.ok) {
        console.warn(`  [CH] ${companyNumber} → HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`  [CH] ${companyNumber} → fetch error: ${err.message}`);
      return null;
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log(`\n🔍 backfill_ch_data — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

// Fetch all targets with a CH number but missing at least one of the new columns
let allTargets = [];
let offset = 0;
while (true) {
  const { data, error } = await supabase
    .from('targets')
    .select('id, title, domain, companies_house_number, sic_codes, company_status, incorporated_at')
    .not('companies_house_number', 'is', null)
    .or('sic_codes.is.null,company_status.is.null,incorporated_at.is.null')
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) { console.error('Supabase fetch error:', error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  allTargets.push(...data);
  if (data.length < PAGE_SIZE) break;
  offset += PAGE_SIZE;
}

console.log(`Found ${allTargets.length} targets to backfill.\n`);
if (allTargets.length === 0) { console.log('Nothing to do.'); process.exit(0); }

let updated = 0;
let skipped = 0;
let failed  = 0;

for (let i = 0; i < allTargets.length; i++) {
  const t = allTargets[i];
  const label = t.title ?? t.domain ?? t.id;
  process.stdout.write(`[${i + 1}/${allTargets.length}] ${label} (${t.companies_house_number}) … `);

  const profile = await getCompanyProfile(t.companies_house_number);
  if (!profile) {
    console.log('skipped (no CH profile)');
    skipped++;
    continue;
  }

  const sicCodes     = profile.sic_codes ?? null;
  const status       = profile.company_status ?? null;
  const incorporated = profile.date_of_creation ?? null;

  // Only write fields that are currently null — don't overwrite existing data
  const patch = {};
  if (!t.sic_codes      && sicCodes)     patch.sic_codes      = sicCodes;
  if (!t.company_status && status)       patch.company_status = status;
  if (!t.incorporated_at && incorporated) patch.incorporated_at = incorporated;

  if (Object.keys(patch).length === 0) {
    console.log('skipped (already populated)');
    skipped++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`would update → ${JSON.stringify(patch)}`);
    updated++;
    continue;
  }

  const { error: updateErr } = await supabase
    .from('targets')
    .update(patch)
    .eq('id', t.id);

  if (updateErr) {
    console.log(`FAILED: ${updateErr.message}`);
    failed++;
  } else {
    console.log(`updated (${Object.keys(patch).join(', ')})`);
    updated++;
  }
}

console.log(`\n✅ Done — ${updated} updated, ${skipped} skipped, ${failed} failed.\n`);
