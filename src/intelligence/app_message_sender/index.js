// -------------------------------------------------------------------------
// APP MESSAGE SENDER
// Sends agent messages to a user's chat by saving them to the messages table.
// Called by skill_output_processor (and other internal processors) when they
// need to push a message back to the user after async work completes.
// -------------------------------------------------------------------------

import { getSupabaseAdmin } from '../../config/supabase.js';
import { getOpenAI } from '../../config/openai.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { broadcastTyping } from '../typing_broadcaster/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function callClaude({ model, max_tokens, system, messages, ...rest }, retries = 4) {
  const openaiMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  const params = { model, max_completion_tokens: max_tokens, messages: openaiMessages, ...rest };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await getOpenAI().chat.completions.create(params);
      return { content: [{ text: res.choices[0].message.content }] };
    } catch (err) {
      const status = err?.status;
      if ((status === 429 || status === 529) && attempt < retries - 1) {
        const wait = status === 529 ? 8000 : 60000;
        console.log(`[app_message_sender] ${status} error, waiting ${wait / 1000}s before retry ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

const skillPromptMap = {
  'lead_gen_expert/analyse_website': 'analyse_website.md',
  'business_analyst/define_itp': 'define_itp.md',
  'lead_gen_expert/itp_refiner': 'itp_refiner.md',
  'lead_gen_expert/target_finder_ten_leads': 'target_finder_ten_leads.md',
  'email_campaign_manager/create_campaign': 'create_campaign.md',
  'email_campaign_manager/launch_campaign': 'launch_campaign.md',
  'email_campaign_manager/sync_to_smartlead': 'sync_to_smartlead.md',
  'email_campaign_manager/reply_received': 'reply_received.md',
};

export async function sendDirectResponse({ user_details_id, conversationHistory }) {
  await broadcastTyping(user_details_id, true);

  try {
    const directResponsePrompt = await readFile(join(__dirname, 'direct_response.md'), 'utf-8');

    const response = await callClaude({
      model: 'gpt-5-mini',
      max_tokens: 512,
      system: directResponsePrompt,
      messages: [{ role: 'user', content: conversationHistory }],
    });

    const message_body = response.content[0].text.trim();

    const { error } = await getSupabaseAdmin()
      .from('messages')
      .insert({ user_details_id, message_body, is_agent: true });

    if (error) throw new Error('sendDirectResponse: failed to save message — ' + error.message);
  } finally {
    await broadcastTyping(user_details_id, false);
  }
}

export async function sendAppMessage({ type, employee, skill, user_details_id, sidebar = null, navigate_to = null, output }) {
  await broadcastTyping(user_details_id, true);

  try {
    const corePrompt = await readFile(join(__dirname, 'core_prompt.md'), 'utf-8');

    const skillPromptFile = skillPromptMap[`${employee}/${skill}`];
    const skillPrompt = skillPromptFile
      ? await readFile(join(__dirname, skillPromptFile), 'utf-8')
      : null;

    const systemPrompt = skillPrompt ? `${corePrompt}\n\n---\n\n${skillPrompt}` : corePrompt;

    const userMessage = JSON.stringify({ type, employee, skill, output }, null, 2);

    const response = await callClaude({
      model: 'gpt-5-nano',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const message_body = response.content[0].text.trim();

    const { error } = await getSupabaseAdmin()
      .from('messages')
      .insert({ user_details_id, message_body, is_agent: true, sidebar, sidebar_info: sidebar ? output : null, navigate_to });

    if (error) throw new Error('app_message_sender: failed to save message — ' + error.message);
  } finally {
    await broadcastTyping(user_details_id, false);
  }
}
