import { getOpenAI } from '../../config/openai.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSupabaseAdmin } from '../../config/supabase.js';
import { triggerMobilisation } from '../../mobilisations/index.js';
import { sendSignupResponse } from '../signup_message_sender/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadPrompt(filename) {
  const filePath = join(__dirname, filename);
  return readFile(filePath, 'utf-8');
}

function formatMessagesForClaude(messages) {
  return messages.map(msg => ({
    role: msg.is_agent ? 'assistant' : 'user',
    content: `[is_agent: ${msg.is_agent}] ${msg.message_body}`,
  }));
}

export async function processSignup(req, res) {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    const [corePrompt, decisionLogicPrompt] = await Promise.all([
      loadPrompt('core_prompt.md'),
      loadPrompt('decision_logic_prompt.md'),
    ]);

    const systemPrompt = [corePrompt, decisionLogicPrompt].filter(Boolean).join('\n\n---\n\n');

    const claudeMessages = formatMessagesForClaude(messages);

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 256,
      messages: [{ role: 'system', content: systemPrompt }, ...claudeMessages],
    });

    const raw = response.choices[0].message.content.trim();
    const result = JSON.parse(raw);

    await getSupabaseAdmin().from('signup_processor_logs').insert({
      timestamp: new Date().toISOString(),
      request: { messages: claudeMessages, system: systemPrompt },
      response: result,
    });

    // -------------------------------------------------------------------------
    // MOBILISATION TRIGGER
    // If Claude returns path: "trigger_mobilisation", we hand off to the
    // mobilisation dispatcher in src/mobilisations/index.js
    // The first step of the mobilisation is included in the response as "step".
    // -------------------------------------------------------------------------
    if (result.path === 'trigger_mobilisation' && result.mobilisation) {
      const step = await triggerMobilisation(result.mobilisation, messages);
      return res.json({ ...result, step });
    }

    // -------------------------------------------------------------------------
    // DIRECT RESPONSE
    // If Claude returns path: "direct_response", we pass the messages to
    // signup_message_sender in src/intelligence/signup_message_sender/index.js which generates
    // Watson's reply and returns it as "reply" for the frontend to display.
    // -------------------------------------------------------------------------
    if (result.path === 'direct_response') {
      const reply = await sendSignupResponse(messages);
      return res.json({ ...result, reply });
    }

    return res.json(result);
  } catch (err) {
    console.error('signup_processor error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
