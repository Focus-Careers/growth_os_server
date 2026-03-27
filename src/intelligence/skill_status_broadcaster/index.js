import { getSupabaseAdmin } from '../../config/supabase.js';

/**
 * Broadcast skill status to the frontend via Supabase real-time.
 * @param {string} user_details_id
 * @param {{ employee: string, skill: string, status: 'running' | 'complete', message?: string }} payload
 */
export async function broadcastSkillStatus(user_details_id, { employee, skill, status, message, sidebar_message }) {
  try {
    await getSupabaseAdmin().channel(`skill_status:${user_details_id}`).send({
      type: 'broadcast',
      event: 'skill_status',
      payload: { employee, skill, status, message, sidebar_message },
    });
    console.log(`[skill_status] ${status}: ${employee}/${skill} for ${user_details_id}`);
  } catch (err) {
    console.error('[skill_status] broadcast error:', err);
  }
}
