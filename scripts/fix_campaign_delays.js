/**
 * One-time script: find all campaigns with duplicate or non-increasing email
 * sequence delays, fix them in the DB, and re-push to Smartlead where synced.
 *
 * Usage: node scripts/fix_campaign_delays.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../.env') });

const SMARTLEAD_BASE_URL = 'https://server.smartlead.ai/api/v1';

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const STANDARD_DELAYS = [0, 3, 5, 7, 10, 14, 18, 22];

function hasValidDelays(sequence) {
  return sequence.every((email, i) => i === 0 || email.delay_in_days > sequence[i - 1].delay_in_days);
}

function fixDelays(sequence) {
  return sequence.map((email, i) => ({
    ...email,
    delay_in_days: i < STANDARD_DELAYS.length
      ? STANDARD_DELAYS[i]
      : STANDARD_DELAYS[STANDARD_DELAYS.length - 1] + (i - STANDARD_DELAYS.length + 1) * 4,
  }));
}

async function pushToSmartlead(slCampaignId, sequence) {
  const formatted = sequence.map(seq => ({
    seq_number: seq.seq_number,
    seq_delay_details: { delay_in_days: seq.delay_in_days },
    subject: seq.subject,
    email_body: seq.body,
  }));
  const res = await fetch(`${SMARTLEAD_BASE_URL}/campaigns/${slCampaignId}/sequences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SMARTLEAD_API_KEY },
    body: JSON.stringify({ sequences: formatted }),
  });
  if (!res.ok) {
    // Retry with bare array
    const retry = await fetch(`${SMARTLEAD_BASE_URL}/campaigns/${slCampaignId}/sequences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SMARTLEAD_API_KEY },
      body: JSON.stringify(formatted),
    });
    return retry.ok;
  }
  return true;
}

async function main() {
  console.log('Fetching all campaigns with email sequences...');
  const { data: campaigns, error } = await admin
    .from('campaigns')
    .select('id, name, email_sequence, smartlead_campaign_id')
    .not('email_sequence', 'is', null);

  if (error) { console.error('Failed to fetch campaigns:', error); process.exit(1); }

  console.log(`Found ${campaigns.length} campaigns to check.\n`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const campaign of campaigns) {
    const seq = campaign.email_sequence;
    if (!Array.isArray(seq) || seq.length < 2) { skipped++; continue; }
    if (hasValidDelays(seq)) { skipped++; continue; }

    const before = seq.map(s => s.delay_in_days).join(', ');
    const corrected = fixDelays(seq);
    const after = corrected.map(s => s.delay_in_days).join(', ');

    console.log(`[${campaign.name}] (${campaign.id})`);
    console.log(`  delays: [${before}] → [${after}]`);

    // Update DB
    const { error: updateError } = await admin
      .from('campaigns')
      .update({ email_sequence: corrected })
      .eq('id', campaign.id);

    if (updateError) {
      console.log(`  DB update FAILED: ${updateError.message}`);
      failed++;
      continue;
    }

    // Re-sync to Smartlead if connected
    const slId = campaign.smartlead_campaign_id;
    if (slId && slId !== 'syncing') {
      const ok = await pushToSmartlead(parseInt(slId), corrected);
      console.log(`  Smartlead re-sync: ${ok ? 'OK' : 'FAILED'}`);
      if (!ok) { failed++; continue; }
    } else {
      console.log(`  Smartlead: not synced, skipping`);
    }

    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}, Already correct: ${skipped}, Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
