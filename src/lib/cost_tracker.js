import { getSupabaseAdmin } from '../config/supabase.js';

// USD cost per API call
const COST_PER_CALL_USD = {
  serper: 0.0012,    // $60 / 50,000 credits
  haiku:  0.0020,    // gpt-5-mini: ~$0.25/1M input + $2.00/1M output; ~2000 in + 512 out ≈ $0.0016 per call
  apollo: 0.024750,  // $99 / 4,000 credits
};

// Live GBP/USD rate cache (refreshed every 12 hours)
let _gbpPerUsd = null;
let _rateLastFetched = 0;
const RATE_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_FALLBACK = 0.79; // fallback if API is unreachable

async function getGbpPerUsd() {
  if (_gbpPerUsd && Date.now() - _rateLastFetched < RATE_TTL_MS) return _gbpPerUsd;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=GBP');
    const data = await res.json();
    _gbpPerUsd = data.rates.GBP;
    _rateLastFetched = Date.now();
    console.log(`[cost_tracker] GBP/USD rate updated: ${_gbpPerUsd}`);
  } catch (err) {
    if (!_gbpPerUsd) _gbpPerUsd = RATE_FALLBACK;
    console.warn('[cost_tracker] Failed to fetch GBP/USD rate, using fallback:', err.message);
  }
  return _gbpPerUsd;
}

// Returns cost per call in pence using live exchange rate
async function costPence() {
  const rate = await getGbpPerUsd();
  return {
    serper: COST_PER_CALL_USD.serper * rate * 100,
    haiku:  COST_PER_CALL_USD.haiku  * rate * 100,
    apollo: COST_PER_CALL_USD.apollo * rate * 100,
  };
}

/**
 * Open a new lead generation run record.
 * Returns the run ID to pass into subsequent calls.
 */
export async function openRun({ account_id, itp_id, campaign_id = null, user_details_id = null }) {
  const { data, error } = await getSupabaseAdmin()
    .from('lead_generation_runs')
    .insert({ account_id, itp_id, campaign_id, user_details_id, status: 'running' })
    .select('id')
    .single();

  if (error) {
    console.error('[cost_tracker] Failed to open run:', error.message);
    return null;
  }

  console.log(`[cost_tracker] Opened run ${data.id}`);
  return data.id;
}

/**
 * Increment one or more counter fields on a run.
 * Safely handles null runId (just logs and returns).
 *
 * @param {string|null} runId
 * @param {object} increments - e.g. { serper_calls_used: 1, ch_companies_found: 42 }
 */
export async function increment(runId, increments) {
  if (!runId) return;

  // Fetch current values — always include all cost-relevant fields so
  // estimated_cost_pence is recalculated correctly regardless of which
  // counter is being incremented this call.
  const costFields = ['serper_calls_used', 'haiku_calls_used', 'apollo_credits_used'];
  const allFields = [...new Set([...Object.keys(increments), ...costFields])];
  const { data: current, error: fetchError } = await getSupabaseAdmin()
    .from('lead_generation_runs')
    .select(allFields.join(', '))
    .eq('id', runId)
    .single();

  if (fetchError || !current) {
    console.error('[cost_tracker] Failed to fetch run for increment:', fetchError?.message);
    return;
  }

  const updates = {};
  for (const field of Object.keys(increments)) {
    updates[field] = (current[field] ?? 0) + (increments[field] ?? 0);
  }

  // Recalculate estimated cost from updated API usage using live GBP/USD rate
  const serper = updates.serper_calls_used ?? current.serper_calls_used ?? 0;
  const haiku  = updates.haiku_calls_used  ?? current.haiku_calls_used  ?? 0;
  const apollo = updates.apollo_credits_used ?? current.apollo_credits_used ?? 0;
  const pence  = await costPence();

  updates.estimated_cost_pence = Math.round(
    serper * pence.serper +
    haiku  * pence.haiku  +
    apollo * pence.apollo
  );

  const { error: updateError } = await getSupabaseAdmin()
    .from('lead_generation_runs')
    .update(updates)
    .eq('id', runId);

  if (updateError) {
    console.error('[cost_tracker] Failed to increment run:', updateError.message);
  }
}

/**
 * Close a run, setting final status and completed_at.
 *
 * @param {string|null} runId
 * @param {'completed'|'failed'|'partial'} status
 * @param {string|null} errorMessage
 */
export async function closeRun(runId, status = 'completed', errorMessage = null) {
  if (!runId) return;

  const { error } = await getSupabaseAdmin()
    .from('lead_generation_runs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .eq('id', runId);

  if (error) {
    console.error('[cost_tracker] Failed to close run:', error.message);
    return;
  }

  console.log(`[cost_tracker] Closed run ${runId} — ${status}`);
}
