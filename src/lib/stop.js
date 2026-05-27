// -------------------------------------------------------------------------
// STOP
// User-initiated cancellation. Halts any in-flight run, clears the state that
// blocks the user from talking to Watson, and tells the frontend to tear down
// mobilisation option pills / step UI.
//
// Does NOT delete chat history, and does NOT roll back work already committed
// (targets/leads already written, contacts already pushed to Smartlead). Stop
// halts forward progress and resets the conversation to an idle state.
// -------------------------------------------------------------------------

import { getSupabaseAdmin } from '../config/supabase.js';
import { abortRun } from './cancellation.js';

export async function stopForUser(userDetailsId) {
  if (!userDetailsId) return;

  // 1. Signal any in-flight skill run to abort (cooperative — see cancellation.js).
  const aborted = abortRun(userDetailsId);

  // 2. Clear the state that locks the user mid-flow. Clearing active_mobilisation
  //    is what lets app_message_processor route the user's messages again.
  await getSupabaseAdmin()
    .from('user_details')
    .update({
      active_mobilisation: null,
      active_step_id: null,
      queued_mobilisations: [],
      active_skill: null,
    })
    .eq('id', userDetailsId);

  // 3. Tell the frontend to drop any option pills / mobilisation step UI and
    //  re-enable the chat input.
  await getSupabaseAdmin().channel(`user:${userDetailsId}`).send({
    type: 'broadcast',
    event: 'cancelled',
    payload: { at: new Date().toISOString() },
  });

  console.log(`[stop] stopForUser ${userDetailsId} (in-flight run aborted: ${aborted})`);
}
