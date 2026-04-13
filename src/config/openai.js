import OpenAI from 'openai';

let client = null;

export function getOpenAI() {
  if (!client) {
    const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // GPT-5 family are reasoning models. Internal reasoning tokens count against
    // max_completion_tokens, so a budget of 256/1024 leaves nothing for output.
    // Intercept all chat.completions.create calls to enforce a safe minimum and
    // set reasoning_effort: 'low' for simple tasks.
    const originalCreate = raw.chat.completions.create.bind(raw.chat.completions);
    raw.chat.completions.create = (params) => originalCreate({
      reasoning_effort: 'low',
      ...params,
      max_completion_tokens: Math.max(params.max_completion_tokens ?? 1024, 8192),
    });

    client = raw;
  }
  return client;
}
