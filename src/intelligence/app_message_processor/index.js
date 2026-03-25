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

  const systemPrompt = `${decisionPrompt}\n\n${skillsSection}`;

  // Build conversation history as user message
  const conversationHistory = (history ?? []).map(m =>
    `${m.is_agent ? 'Watson (CMO)' : 'User'}: ${m.message_body}`
  ).join('\n');

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
    const mobilisationName = `initiate_${skill}`;
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
