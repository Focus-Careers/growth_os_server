// -------------------------------------------------------------------------
// SIGNUP SENDER
// Called internally by signup_processor when Claude returns direct_response.
// Loads core_prompt.md, sends the conversation to Claude, logs the
// interaction to signup_sender_logs, and returns the reply text.
// -------------------------------------------------------------------------

import { getOpenAI } from '../../config/openai.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function formatMessagesForClaude(messages) {
  return messages.map(msg => ({
    role: msg.is_agent ? 'assistant' : 'user',
    content: `[is_agent: ${msg.is_agent}] ${msg.message_body}`,
  }));
}

export async function sendSignupResponse(messages) {
  const corePrompt = await readFile(join(__dirname, 'core_prompt.md'), 'utf-8');

  const claudeMessages = formatMessagesForClaude(messages);

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5',
    max_completion_tokens: 1024,
    messages: [{ role: 'system', content: corePrompt }, ...claudeMessages],
  });

  const replyText = response.choices[0].message.content.trim();

  await getSupabaseAdmin().from('signup_sender_logs').insert({
    timestamp: new Date().toISOString(),
    request: { messages: claudeMessages, system: corePrompt },
    response: { reply: replyText },
  });

  return replyText;
}
