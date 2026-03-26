// -------------------------------------------------------------------------
// APP MESSAGE PROCESSOR
// Receives new user messages via Supabase webhook.
// Checks signup status, builds a decision prompt for Claude, and routes.
// -------------------------------------------------------------------------

import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSupabaseAdmin } from '../../config/supabase.js';
import { getAnthropic } from '../../config/anthropic.js';
import { sendDirectResponse } from '../app_message_sender/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const employeesDir = join(__dirname, '../../employees');

async function loadSkillDescriptions() {
  const entries = await readdir(employeesDir, { recursive: true });
  const descFiles = entries.filter(e => e.endsWith('description_for_msg_processor.md'));

  const skills = await Promise.all(descFiles.map(async (relPath) => {
    // relPath e.g. "lead_gen_expert/skills/target_finder/description_for_msg_processor.md"
    const parts = relPath.split('/');
    const employee = parts[0];
    const skill = parts[2];
    const content = await readFile(join(employeesDir, relPath), 'utf-8');
    return { employee, skill, content: content.trim() };
  }));

  return skills;
}

export async function processMessage(record) {
  const { user_details_id } = record;

  if (record.is_agent) return;

  const { data: userDetails } = await getSupabaseAdmin()
    .from('user_details')
    .select('signup_complete, active_mobilisation')
    .eq('id', user_details_id)
    .single();

  console.log(`[amp] signup_complete=${userDetails?.signup_complete} active_mobilisation=${userDetails?.active_mobilisation} for ${user_details_id}`);
  if (!userDetails?.signup_complete) return;
  if (userDetails?.active_mobilisation) return;

  console.log('[amp] loading messages...');
  const { data: history } = await getSupabaseAdmin()
    .from('messages')
    .select('message_body, is_agent')
    .eq('user_details_id', user_details_id)
    .order('created_at', { ascending: true })
    .limit(50);

  // Load context about what's already in progress to prevent re-triggering
  const { data: ud } = await getSupabaseAdmin()
    .from('user_details').select('account_id, queued_mobilisations').eq('id', user_details_id).single();

  let activeContext = '';
  if (ud?.account_id) {
    const { data: pendingLeads } = await getSupabaseAdmin()
      .from('leads').select('id', { count: 'exact', head: true }).eq('approved', false).eq('rejected', false);
    const { data: campaigns } = await getSupabaseAdmin()
      .from('campaigns').select('id, name, status').eq('account_id', ud.account_id);

    // Check if ITP is validated (10+ approved leads)
    const { data: approvedLeads } = await getSupabaseAdmin()
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('approved', true);

    const itpValidated = (approvedLeads?.length ?? 0) >= 10;

    const contextParts = [];
    if (pendingLeads?.length) contextParts.push(`Target finder is already running or has ${pendingLeads.length} leads awaiting approval in the Belfort tab.`);
    if (ud.queued_mobilisations?.length) contextParts.push(`There are ${ud.queued_mobilisations.length} queued actions waiting to run.`);
    if (campaigns?.length) contextParts.push(`Existing campaigns: ${campaigns.map(c => `${c.name} (${c.status})`).join(', ')}.`);

    if (!itpValidated) {
      contextParts.push('The ITP has NOT been validated yet (fewer than 10 approved leads). If the user wants to create a campaign, explain that we need to find and approve leads first to make sure the ITP is accurate. Suggest starting with target finding instead.');
    } else {
      contextParts.push('The ITP has been validated with 10+ approved leads. Campaign creation is available.');
    }
    if (contextParts.length) activeContext = `\n\n# Current State\n${contextParts.join('\n')}\nDo NOT suggest skills that are already in progress or recently completed. If targets are already being found or awaiting approval, do not trigger target_finder again.`;
  }

  console.log(`[amp] loaded ${history?.length} messages, loading prompts...`);
  const [decisionPrompt, skillDescriptions] = await Promise.all([
    readFile(join(__dirname, 'decision_logic_prompt.md'), 'utf-8'),
    loadSkillDescriptions(),
  ]);
  console.log(`[amp] loaded ${skillDescriptions.length} skill descriptions, calling Claude...`);

  // Build system prompt: decision logic + available skill descriptions
  const skillsSection = skillDescriptions.map(({ employee, skill, content }) =>
    `## ${employee} / ${skill}\n${content}`
  ).join('\n\n');

  const systemPrompt = `${decisionPrompt}\n\n${skillsSection}${activeContext}`;

  // Build conversation history — last 10 messages for context, with the actual user message highlighted
  const recentHistory = (history ?? []).slice(-10);
  const userMessage = record.message_body ?? recentHistory[recentHistory.length - 1]?.message_body ?? '';

  const conversationHistory = [
    '# Recent conversation:',
    ...recentHistory.map(m => `${m.is_agent ? 'Watson (CMO)' : 'User'}: ${m.message_body}`),
    '',
    '# LATEST MESSAGE FROM USER (this is what you need to route):',
    `User: ${userMessage}`,
  ].join('\n');

  console.log('[amp] LATEST USER MESSAGE:', userMessage);

  const claudeRequest = {
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: conversationHistory }],
  };

  const response = await getAnthropic().messages.create(claudeRequest);

  const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let decision;
  try {
    decision = JSON.parse(raw);
  } catch (parseError) {
    console.error('[amp] Failed to parse Claude response as JSON:', parseError.message, '| raw text:', raw);
    decision = { path: 'direct_response' };
  }

  await getSupabaseAdmin().from('app_message_processor_logs').insert({
    user_details_id,
    request: { messages: claudeRequest.messages, system: claudeRequest.system },
    response: decision,
  });

  console.log('app_message_processor decision:', decision);

  if (decision.path === 'direct_response') {
    console.log('[amp] routing to direct_response');
    await sendDirectResponse({ user_details_id, conversationHistory });
    return;
  }

  if (decision.path === 'trigger_skill') {
    const { employee, skill } = decision;
    // Map skill names to their mobilisation names
    const skillToMobilisation = {
      'target_finder_ten_leads': 'initiate_target_finder_ten_leads',
      'create_campaign': 'initiate_create_campaign',
      'create_new_sender': 'setup_sender',
      'analyse_website': 'sign_up_get_website',
      'define_itp': 'signup_ideal_target_profile',
    };
    const mobilisationName = skillToMobilisation[skill] ?? `initiate_${skill}`;
    console.log(`[amp] trigger_skill → ${employee}/${skill} → broadcasting start_mobilisation: ${mobilisationName}`);
    await getSupabaseAdmin().channel(`user:${user_details_id}`).send({
      type: 'broadcast',
      event: 'start_mobilisation',
      payload: { mobilisation: mobilisationName },
    });
    return;
  }

  console.warn('[amp] unknown decision path:', decision.path);
}
