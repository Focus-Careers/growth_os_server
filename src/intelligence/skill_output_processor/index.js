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

    case 'business_analyst/analyse_customers': {
      if (output.skipped) {
        // No customers or no ITP — broadcast start_mobilisation directly
        console.log(`[skill_output] analyse_customers skipped (${output.reason}), broadcasting signed_up_first_message`);
        await getSupabaseAdmin().channel(`user:${user_details_id}`).send({
          type: 'broadcast',
          event: 'start_mobilisation',
          payload: { mobilisation: 'signed_up_first_message' },
        });
      } else {
        // Refined ITP — update the existing ITP record and show for review
        const itpId = output.itp_id;
        if (itpId) {
          await getSupabaseAdmin().from('itp').update({
            name: output.name ?? null,
            itp_summary: output.itp_summary ?? null,
            itp_demographic: output.demographics ?? null,
            itp_pain_points: output.pain_points ?? null,
            itp_buying_trigger: output.buying_trigger ?? null,
            location: output.location ?? null,
            sic_codes: null, // Clear cached SIC codes so they get regenerated
          }).eq('id', itpId);
        }
        await sendAppMessage({
          type: 'skill_output',
          employee,
          skill: skill_name,
          user_details_id,
          sidebar: 'define_itp',
          output: { ...output, itp_id: itpId },
        });
      }
      break;
    }

    case 'lead_gen_expert/target_finder_ten_leads': {
      const highScoreCount = output.high_score_count ?? 0;
      const totalTargets = output.total_targets ?? 0;

      // Check if THIS ITP already has 10+ approved leads — if so, auto-approve new ones
      const { count: existingApproved } = await getSupabaseAdmin()
        .from('leads').select('id', { count: 'exact', head: true })
        .eq('itp_id', output.itp_id)
        .eq('approved', true);
      const alreadyValidated = (existingApproved ?? 0) >= 10;

      if (alreadyValidated && output.itp_id) {
        // Auto-approve all new unapproved high-score leads
        await getSupabaseAdmin()
          .from('leads')
          .update({ approved: true })
          .eq('itp_id', output.itp_id)
          .gte('score', 70)
          .is('approved', null)
          .is('rejected', null);
        console.log(`[skill_output] Auto-approved new leads for validated ITP`);
      }

      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: (!alreadyValidated && highScoreCount > 0) ? 'approve_targets' : null,
        navigate_to: alreadyValidated ? 'Belfort' : null,
        output: { high_score_count: highScoreCount, total_targets: totalTargets, itp_id: output.itp_id, auto_approved: alreadyValidated },
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
        sidebar: null,
        output: { approved_count: approvedCount, total_targets: totalTargets, itp_id: output.itp_id },
      });
      break;
    }

    case 'lead_gen_expert/itp_refiner': {
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: null,
        output,
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
        sidebar: null,
        output: { lead_id: output.lead_id, contact_count: contactCount },
      });
      break;
    }

    case 'email_campaign_manager/create_new_sender': {
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: null,
        output,
      });
      break;
    }

    case 'email_campaign_manager/create_campaign': {
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: 'review_email_template',
        output,
      });
      break;
    }

    case 'email_campaign_manager/sync_to_smartlead': {
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: null,
        output,
      });
      break;
    }

    case 'email_campaign_manager/launch_campaign': {
      await sendAppMessage({
        type: 'skill_output',
        employee,
        skill: skill_name,
        user_details_id,
        sidebar: null,
        navigate_to: 'Draper',
        output,
      });
      break;
    }

    default:
      console.warn(`skill_output_processor: no handler for ${key}`);
  }
}
