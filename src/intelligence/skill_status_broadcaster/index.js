import { getSupabaseAdmin } from '../../config/supabase.js';

/**
 * Broadcast skill status to the frontend via Supabase real-time.
 * When status is 'running', also persists the message to the messages table
 * so it survives page refreshes (unless persist is false).
 * @param {string} user_details_id
 * @param {{ employee: string, skill: string, status: 'running' | 'complete', message?: string, sidebar_message?: string, persist?: boolean }} payload
 */
export async function broadcastSkillStatus(user_details_id, { employee, skill, status, message, sidebar_message, persist = true }) {
  try {
    await getSupabaseAdmin().channel(`skill_status:${user_details_id}`).send({
      type: 'broadcast',
      event: 'skill_status',
      payload: { employee, skill, status, message, sidebar_message },
    });

    // Persist status messages to DB so they survive page refresh
    if (status === 'running' && message && persist) {
      await getSupabaseAdmin()
        .from('messages')
        .insert({
          user_details_id,
          message_body: message,
          is_agent: true,
          is_status: true,
        });
    }

    if (persist) console.log(`[skill_status] ${status}: ${employee}/${skill} for ${user_details_id}`);
  } catch (err) {
    console.error('[skill_status] broadcast error:', err);
  }
}
