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

    default:
      console.warn(`skill_output_processor: no handler for ${key}`);
  }
}
