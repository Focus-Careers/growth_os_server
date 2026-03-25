import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

export async function executeSkill({ user_details_id, email, display_name }) {
  const admin = getSupabaseAdmin();

  // Look up account_id
  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();

  if (!userDetails?.account_id) {
    console.error('[create_new_sender] No account found for user', user_details_id);
    return { error: 'no_account' };
  }

  // Check if sender already exists
  const { data: existing } = await admin
    .from('senders')
    .select('id')
    .eq('account_id', userDetails.account_id)
    .eq('email', email.toLowerCase())
    .single();

  if (existing) {
    await processSkillOutput({
      employee: 'email_campaign_manager',
      skill_name: 'create_new_sender',
      user_details_id,
      output: { sender_id: existing.id, email, display_name, already_existed: true },
    });
    return { sender_id: existing.id, already_existed: true };
  }

  // Create new sender
  const { data: sender, error } = await admin
    .from('senders')
    .insert({
      account_id: userDetails.account_id,
      email: email.toLowerCase(),
      display_name: display_name || null,
      provider: 'smartlead',
      verified: false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[create_new_sender] Insert error:', error);
    return { error: 'insert_failed' };
  }

  await processSkillOutput({
    employee: 'email_campaign_manager',
    skill_name: 'create_new_sender',
    user_details_id,
    output: { sender_id: sender.id, email, display_name, already_existed: false },
  });

  return { sender_id: sender.id };
}
