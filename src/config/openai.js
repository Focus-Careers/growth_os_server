import OpenAI from 'openai';

let client = null;

// Traffic goes through Vercel AI Gateway rather than straight to OpenAI: one bill across every
// product, spend visible per product, and a model change that costs an env var. The wire format is
// unchanged — this is still the OpenAI SDK speaking Chat Completions — so no call site needed to
// know. Model names live in ./models.js.
//
// The base URL is an env var rather than a literal because it is the rollback: point it at another
// OpenAI-compatible endpoint, set the key and the model names to match, restart.
export function getOpenAI() {
  if (!client) {
    const raw = new OpenAI({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseURL: process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v1',
      // Separates GrowthOS spend from the other products in gateway reporting without any call
      // site having to remember it.
      defaultHeaders: { 'ai-reporting-tags': 'service:growthos' },
    });

    // The models are reasoning models. Internal reasoning tokens count against
    // max_completion_tokens, so a budget of 256/1024 leaves nothing for output.
    // Intercept all chat.completions.create calls to enforce a safe minimum and
    // set reasoning_effort: 'low' for simple tasks. The gateway accepts
    // reasoning_effort as an alias for its own reasoning.effort.
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
