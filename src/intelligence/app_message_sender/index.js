// -------------------------------------------------------------------------
// APP MESSAGE SENDER
// Sends agent messages to a user's chat by saving them to the messages table.
// Called by skill_output_processor (and other internal processors) when they
// need to push a message back to the user after async work completes.
// -------------------------------------------------------------------------

import { getSupabaseAdmin } from '../../config/supabase.js';
import { getAnthropic } from '../../config/anthropic.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { broadcastTyping } from '../typing_broadcaster/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const skillPromptMap = {
  'lead_gen_expert/analyse_website': 'analyse_website.md',
  'business_analyst/define_itp': 'define_itp.md',
  'email_campaign_manager/create_campaign': 'create_campaign.md',
};

export async function sendDirectResponse({ user_details_id, conversationHistory }) {
  await broadcastTyping(user_details_id, true);

  const directResponsePrompt = await readFile(join(__dirname, 'direct_response.md'), 'utf-8');

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: directResponsePrompt,
    messages: [{ role: 'user', content: conversationHistory }],
  });

  const message_body = response.content[0].text.trim();
  await broadcastTyping(user_details_id, false);

  const { error } = await getSupabaseAdmin()
    .from('messages')
    .insert({ user_details_id, message_body, is_agent: true });

  if (error) throw new Error('sendDirectResponse: failed to save message — ' + error.message);
}

export async function sendAppMessage({ type, employee, skill, user_details_id, sidebar = null, output }) {
  await broadcastTyping(user_details_id, true)

  const corePrompt = await readFile(join(__dirname, 'core_prompt.md'), 'utf-8');

  const skillPromptFile = skillPromptMap[`${employee}/${skill}`];
  const skillPrompt = skillPromptFile
    ? await readFile(join(__dirname, skillPromptFile), 'utf-8')
    : null;

  const systemPrompt = skillPrompt ? `${corePrompt}\n\n---\n\n${skillPrompt}` : corePrompt;

  const userMessage = JSON.stringify({ type, employee, skill, output }, null, 2);

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const message_body = response.content[0].text.trim();

  const { error } = await getSupabaseAdmin()
    .from('messages')
    .insert({ user_details_id, message_body, is_agent: true, sidebar, sidebar_info: sidebar ? output : null });

  if (error) throw new Error('app_message_sender: failed to save message — ' + error.message);
}
