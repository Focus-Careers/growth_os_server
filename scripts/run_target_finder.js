/**
 * Sequentially runs target_finder_100_leads for a list of campaigns.
 * Waits for each run to complete before starting the next.
 *
 * Usage: node scripts/run_target_finder.js
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:8080').replace(/\/$/, '');
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS  = 2 * 60 * 60 * 1000; // 2 hours per run

const CAMPAIGNS = [
  'fdfd3209-a3dc-459d-85a2-a9cb2c44894b',
  '43c848e7-33d8-4e22-b98e-03169c5038dc',
  'a4db0ecb-b5a6-4a9b-8480-d6d9cdfd340b',
  'f332e12c-9ee0-40c7-a113-2ae6ba4c82a0',
];

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function triggerRun(campaignId) {
  const res = await fetch(`${SERVER_URL}/api/campaigns/find-leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_id: campaignId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Trigger failed: ${JSON.stringify(data)}`);
  return data;
}

async function waitForCompletion(campaignId, since) {
  const sb = getSupabase();
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const { data } = await sb
      .from('lead_generation_runs')
      .select('id, status, estimated_cost_pence, ch_companies_found, serper_calls_used')
      .eq('campaign_id', campaignId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1);

    const run = data?.[0];
    if (!run) continue;

    if (run.status === 'completed' || run.status === 'failed') {
      return run;
    }

    process.stdout.write('.');
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 60000} minutes`);
}

async function main() {
  console.log(`Target: ${SERVER_URL}`);
  console.log(`Running ${CAMPAIGNS.length} campaigns sequentially\n`);

  for (let i = 0; i < CAMPAIGNS.length; i++) {
    const campaignId = CAMPAIGNS[i];
    console.log(`[${i + 1}/${CAMPAIGNS.length}] Starting ${campaignId}...`);

    const since = new Date().toISOString();
    await triggerRun(campaignId);
    console.log(`  Dispatched — waiting for completion`);

    const run = await waitForCompletion(campaignId, since);
    console.log(`\n  ${run.status.toUpperCase()} — CH companies: ${run.ch_companies_found ?? 0} | Serper calls: ${run.serper_calls_used ?? 0} | Cost: ${run.estimated_cost_pence ?? 0}p`);
  }

  console.log('\nAll done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
