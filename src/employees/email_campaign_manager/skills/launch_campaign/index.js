import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { dispatchSkill } from '../../../index.js';

export async function executeSkill({ user_details_id, campaign_id, sender_id }) {
  const admin = getSupabaseAdmin();

  // Update campaign with sender and set to active
  const { error } = await admin
    .from('campaigns')
    .update({ sender_id, status: 'active', updated_at: new Date().toISOString() })
    .eq('id', campaign_id);

  if (error) {
    console.error('[launch_campaign] Update error:', error);
    return { error: 'update_failed' };
  }

  // Get the campaign's ITP to trigger target finder
  const { data: campaign } = await admin
    .from('campaigns')
    .select('itp_id')
    .eq('id', campaign_id)
    .single();

  console.log('[launch_campaign] Campaign activated, triggering target_finder_100_leads');

  // Trigger target_finder_100_leads to fill the campaign with targets
  if (campaign?.itp_id) {
    dispatchSkill('lead_gen_expert', 'target_finder_100_leads', {
      user_details_id,
      itp_id: campaign.itp_id,
      campaign_id,
    }).catch(err => console.error('[launch_campaign] target_finder dispatch error:', err));
  }

  // Sync campaign to Smartlead (testing mode — won't activate)
  dispatchSkill('email_campaign_manager', 'sync_to_smartlead', {
    user_details_id,
    campaign_id,
  }).catch(err => console.error('[launch_campaign] sync_to_smartlead dispatch error:', err));

  await processSkillOutput({
    employee: 'email_campaign_manager',
    skill_name: 'launch_campaign',
    user_details_id,
    output: { campaign_id, status: 'active' },
  });

  return { campaign_id, status: 'active' };
}
