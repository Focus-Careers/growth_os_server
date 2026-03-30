import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../config/anthropic.js';
import { getSupabaseAdmin } from '../../config/supabase.js';
import { dispatchSkill } from '../../employees/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sidebar labels for human-readable context
const SIDEBAR_LABELS = {
  review_email_template: 'reviewing an email campaign sequence',
  select_sender: 'setting up a sender for their campaign',
  select_itp: 'choosing a target profile for lead generation',
  select_campaign_itp: 'choosing a target profile for a campaign',
  approve_targets: 'reviewing and approving target companies',
  define_itp: 'reviewing their ideal target profile',
  analyse_website: 'reviewing a website analysis',
  upload_csv: 'uploading customer data',
  manual_customers: 'adding customers manually',
  target_finder_upload_csv: 'uploading targets',
  target_finder_manual_customers: 'adding targets manually',
};

/**
 * Analyse conversation state and generate a contextual welcome-back greeting.
 * If a skill was running but didn't complete, re-dispatches it.
 * Returns { restore } or null if greeting should be skipped.
 */
export async function analyseAndGreet(user_details_id) {
  const supabase = getSupabaseAdmin();

  // 1. Fetch user details
  const { data: ud } = await supabase
    .from('user_details')
    .select('firstname, active_mobilisation, active_step_id, active_skill, last_welcome_back_at')
    .eq('id', user_details_id)
    .single();

  if (!ud) return null;

  // 2. Guard: skip if last welcome-back was < 1.5 minutes ago
  if (ud.last_welcome_back_at) {
    const elapsed = Date.now() - new Date(ud.last_welcome_back_at).getTime();
    if (elapsed < 90_000) return null;
  }

  // 3. Fetch last 10 messages
  const { data: messages } = await supabase
    .from('messages')
    .select('id, message_body, is_agent, is_status, sidebar, sidebar_info, created_at')
    .eq('user_details_id', user_details_id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) return null;

  // 4. Detect state (priority order)
  let state = 'general_return';
  let context = '';
  let restore = {};

  const lastAgentMsg = messages.find(m => m.is_agent && !m.is_status);

  // a) Active mobilisation — skip greeting, just return restore payload
  if (ud.active_mobilisation) {
    await supabase
      .from('user_details')
      .update({ last_welcome_back_at: new Date().toISOString() })
      .eq('id', user_details_id);
    return { restore: { mobilisation: ud.active_mobilisation, step_id: ud.active_step_id } };
  }
  // b) Skill was running but didn't complete — re-dispatch it
  else if (ud.active_skill) {
    const { employee, skill } = ud.active_skill;
    state = 'skill_restarting';
    context = `A background task (${employee}/${skill}) was interrupted and is being restarted now.`;

    // Re-dispatch the skill (fire-and-forget)
    dispatchSkill(employee, skill, { user_details_id })
      .catch(err => console.error('[welcome-back] skill re-dispatch error:', err));
  }
  // c) Sidebar was open (last agent message has sidebar)
  else if (lastAgentMsg?.sidebar) {
    state = 'sidebar_open';
    const label = SIDEBAR_LABELS[lastAgentMsg.sidebar] ?? lastAgentMsg.sidebar;
    context = `The user was ${label} in the sidebar.`;
    restore = { sidebar: lastAgentMsg.sidebar, sidebar_info: lastAgentMsg.sidebar_info };
  }
  // d) General return — build context from recent messages
  else if (lastAgentMsg) {
    const snippet = lastAgentMsg.message_body.slice(0, 120);
    context = `The last thing Watson said was: "${snippet}"`;
  }

  // 5. Generate greeting via Haiku
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');
  const firstName = ud.firstname ?? 'there';

  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: prompt,
    messages: [{
      role: 'user',
      content: `User's first name: ${firstName}\nState: ${state}\nContext: ${context}\nExperience: ${messages.length > 20 ? 'experienced user (many messages)' : 'newer user (still getting started)'}`,
    }],
  });

  const greeting = response.content[0].text.trim();

  // 6. Save greeting to messages table
  await supabase
    .from('messages')
    .insert({ user_details_id, message_body: greeting, is_agent: true });

  // 7. Update last_welcome_back_at
  await supabase
    .from('user_details')
    .update({ last_welcome_back_at: new Date().toISOString() })
    .eq('id', user_details_id);

  return { restore };
}
