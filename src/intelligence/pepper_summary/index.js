import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a Pepper summary message based on workspace/admin status.
 */
export async function generatePepperSummary(account_id, firstname, user_details_id) {
  const supabase = getSupabaseAdmin();

  // Fetch account details
  const { data: account } = await supabase
    .from('account')
    .select('organisation_name')
    .eq('id', account_id)
    .single();

  // Fetch user details
  const { data: userDetails } = user_details_id
    ? await supabase
        .from('user_details')
        .select('signup_complete, active_skill, queued_mobilisations')
        .eq('id', user_details_id)
        .single()
    : { data: null };

  // Fetch sender count
  const { count: senderCount } = await supabase
    .from('senders')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', account_id);

  // Fetch message count
  const { count: messageCount } = user_details_id
    ? await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('user_details_id', user_details_id)
    : { count: 0 };

  // Build context
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  const activeSkill = userDetails?.active_skill
    ? typeof userDetails.active_skill === 'object'
      ? `${userDetails.active_skill.employee}/${userDetails.active_skill.skill}`
      : String(userDetails.active_skill)
    : 'none';

  const queuedCount = userDetails?.queued_mobilisations?.length ?? 0;

  const context = [
    `Organisation: ${account?.organisation_name ?? 'Not set'}`,
    `Onboarding: ${userDetails?.signup_complete ? 'complete' : 'in progress'}`,
    `Email senders configured: ${senderCount ?? 0}`,
    `Active skill running: ${activeSkill}`,
    `Queued tasks: ${queuedCount}`,
    `Total messages exchanged: ${messageCount ?? 0}`,
  ].join('\n');

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5-nano',
    max_completion_tokens: 256,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `User's first name: ${firstname ?? 'there'}\n\n${context}` },
    ],
  });

  return response.choices[0].message.content.trim();
}
