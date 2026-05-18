import { refineItp } from '../../../../lib/lead_gen/itp_refiner_v2.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { dispatchSkill } from '../../../index.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';

export async function executeSkill({ user_details_id, itp_id, user_feedback, skip_target_finder = false }) {
  const admin = getSupabaseAdmin();

  // Resolve ITP id from user_details if not supplied
  let resolvedItpId = itp_id;
  if (!resolvedItpId && user_details_id) {
    const { data: ud } = await admin
      .from('user_details').select('account_id').eq('id', user_details_id).single();
    if (ud?.account_id) {
      const { data: latest } = await admin
        .from('itp').select('id').eq('account_id', ud.account_id)
        .order('created_at', { ascending: false }).limit(1).single();
      resolvedItpId = latest?.id;
    }
  }
  if (!resolvedItpId) throw new Error('itp_refiner: could not resolve ITP id');

  const result = await refineItp({ itp_id: resolvedItpId, user_feedback });

  // If the refiner says we should escalate, send a Watson message directly and stop looping
  if (result.should_escalate) {
    const escalationMsg = result.escalation_reason
      ?? "We keep finding similar leads that you're rejecting. Can you help clarify what makes the difference? For example: are these companies too large? Wrong location? Wrong type of work?";

    // Insert directly into messages table so it appears in Watson chat
    await admin.from('messages').insert({
      user_details_id,
      message_body: escalationMsg,
      is_agent: true,
      is_status: false,
    });

    // Broadcast so the frontend picks it up in real time
    await broadcastSkillStatus(user_details_id, {
      employee: 'lead_gen_expert',
      skill: 'itp_refiner',
      status: 'complete',
      message: escalationMsg,
      persist: false,
    });

    console.log(`[itp_refiner] Escalated after cycle ${result.cycle_number}`);
    return result;
  }

  if (!skip_target_finder) {
    await processSkillOutput({
      employee: 'lead_gen_expert',
      skill_name: 'itp_refiner',
      user_details_id,
      output: {
        itp_id: resolvedItpId,
        rejection_count: 0, // enriched in processSkillOutput if needed
        changes_summary: result.changes_summary ?? 'ITP updated based on your feedback.',
      },
    });

    console.log('[itp_refiner] Dispatching target_finder_ten_leads with refined ITP');
    dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id: resolvedItpId })
      .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
  }

  return result;
}
