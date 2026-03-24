// -------------------------------------------------------------------------
// SIGNUP SENDER
// Called internally by signup_processor when Claude returns direct_response.
// Loads core_prompt.md, sends the conversation to Claude, logs the
// interaction to signup_sender_logs, and returns the reply text.
// -------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSupabase } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function formatMessagesForClaude(messages) {
  return messages.map(msg => ({
    role: msg.is_agent ? 'assistant' : 'user',
    content: `[is_agent: ${msg.is_agent}] ${msg.message_body}`,
  }));
}

export async function sendSignupResponse(messages) {
  const corePrompt = await readFile(join(__dirname, 'core_prompt.md'), 'utf-8');

  const claudeMessages = formatMessagesForClaude(messages);

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: corePrompt,
    messages: claudeMessages,
  });

  const replyText = response.content[0].text.trim();

  await getSupabase().from('signup_sender_logs').insert({
    timestamp: new Date().toISOString(),
    request: { messages: claudeMessages, system: corePrompt },
    response: { reply: replyText },
  });

  return replyText;
}
