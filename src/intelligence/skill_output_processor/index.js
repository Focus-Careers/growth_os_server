// -------------------------------------------------------------------------
// SKILL OUTPUT PROCESSOR
// Receives the output of a completed skill and decides what to do with it.
// Routes based on employee + skill_name to the appropriate handler.
// -------------------------------------------------------------------------

import { sendAppMessage } from '../app_message_sender/index.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

export async function processSkillOutput({ employee, skill_name, user_details_id, output }) {
  const key = `${employee}/${skill_name}`;

  switch (key) {
    case 'lead_gen_expert/analyse_website':
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'analyse_website',
        output,
      });
      break;

    case 'business_analyst/define_itp': {
      const { data: userDetails } = await getSupabaseAdmin()
        .from('user_details').select('account_id').eq('id', user_details_id).single();
      let itp_id = null;
      if (userDetails?.account_id) {
        const { data: inserted } = await getSupabaseAdmin().from('itp').insert({
          account_id: userDetails.account_id,
          name: output.name ?? null,
          itp_summary: output.itp_summary ?? null,
          itp_demographic: output.demographics ?? null,
          itp_pain_points: output.pain_points ?? null,
          itp_buying_trigger: output.buying_trigger ?? null,
          location: output.location ?? null,
        }).select('id').single();
        itp_id = inserted?.id ?? null;
      }
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'define_itp',
        output: { ...output, itp_id },
      });
      break;
    }

    case 'lead_gen_expert/target_finder_ten_leads': {
      const highScoreCount = output.high_score_count ?? 0;
      const totalTargets = output.total_targets ?? 0;

      if (highScoreCount >= 10) {
        const { data: ud } = await getSupabaseAdmin()
          .from('user_details').select('queued_mobilisations').eq('id', user_details_id).single();
        const queue = ud?.queued_mobilisations ?? [];
        if (!queue.some(q => q.mobilisation === 'ten_70_plus_leads_found')) {
          await getSupabaseAdmin()
            .from('user_details')
            .update({ queued_mobilisations: [...queue, { mobilisation: 'ten_70_plus_leads_found', queued_at: new Date().toISOString() }] })
            .eq('id', user_details_id);
          console.log('[skill_output_processor] Queued ten_70_plus_leads_found for user', user_details_id);
        }
      }

      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'target_finder_ten_leads',
        output: { high_score_count: highScoreCount, total_targets: totalTargets, itp_id: output.itp_id },
      });
      break;
    }

    case 'lead_gen_expert/target_finder_100_leads': {
      const approvedCount = output.approved_count ?? 0;
      const totalTargets = output.total_targets ?? 0;

      if (approvedCount >= output.target_count) {
        const { data: ud } = await getSupabaseAdmin()
          .from('user_details').select('queued_mobilisations').eq('id', user_details_id).single();
        const queue = ud?.queued_mobilisations ?? [];
        if (!queue.some(q => q.mobilisation === '100_approved_leads_found')) {
          await getSupabaseAdmin()
            .from('user_details')
            .update({ queued_mobilisations: [...queue, { mobilisation: '100_approved_leads_found', queued_at: new Date().toISOString() }] })
            .eq('id', user_details_id);
          console.log('[skill_output_processor] Queued 100_approved_leads_found for user', user_details_id);
        }
      }

      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'target_finder_100_leads',
        output: { approved_count: approvedCount, total_targets: totalTargets, itp_id: output.itp_id },
      });
      break;
    }

    case 'lead_gen_expert/contact_finder': {
      const contactCount = output.contacts?.length ?? 0;
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'contact_finder',
        output: { lead_id: output.lead_id, contact_count: contactCount },
      });
      break;
    }

    default:
      console.warn(`skill_output_processor: no handler for ${key}`);
  }
}
