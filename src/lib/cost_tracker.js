import { getSupabaseAdmin } from '../config/supabase.js';

// Approximate cost per API call, in pence (GBP)
// Using ~$1.25 = £1 conversion
const COST_PER_CALL_PENCE = {
  serper: 0.10,  // $60 / 50,000 credits = $0.0012/call → ~0.10p
  haiku:  0.80,  // ~$0.01 per scoring batch (rough estimate)
  apollo: 2.00,  // $99 / 4,000 credits = $0.02475/credit → ~2.0p
};

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

  // Recalculate estimated cost from updated API usage
  const serper = updates.serper_calls_used ?? current.serper_calls_used ?? 0;
  const haiku  = updates.haiku_calls_used  ?? current.haiku_calls_used  ?? 0;
  const apollo = updates.apollo_credits_used ?? current.apollo_credits_used ?? 0;

  updates.estimated_cost_pence = Math.round(
    serper * COST_PER_CALL_PENCE.serper +
    haiku  * COST_PER_CALL_PENCE.haiku  +
    apollo * COST_PER_CALL_PENCE.apollo
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
