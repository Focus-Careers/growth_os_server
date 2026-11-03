// Every model name GrowthOS uses, in one place, keyed by the rung of the lineup the call sits on
// rather than by the model that happens to fill that rung today. Call sites never name a model.
//
// The rungs map one-for-one onto the old GPT-5 lineup, so moving generations is a change here
// and nowhere else:
//   fast     — was gpt-5-nano
//   standard — was gpt-5-mini
//   deep     — was gpt-5
//
// The "openai/" prefix is part of the name, not decoration: AI Gateway routes on it, so a bare
// "gpt-6-luna" is a 404 rather than a fallback. Each can be overridden by env var without a deploy.

export const MODELS = {
  // Persona summaries, the contact finder, the invited-member welcome. Short, internal, high volume.
  fast: process.env.MODEL_FAST ?? 'openai/gpt-6-luna',

  // The workhorse: lead-gen scoring and classification, message routing and replies, and the two
  // user-facing generators that were moved up off nano because nano was too weak for them.
  standard: process.env.MODEL_STANDARD ?? 'openai/gpt-6.1-terra',

  // ITP definition, campaign creation, website analysis, the signup message. Run rarely, and the
  // output is what a customer reads first.
  deep: process.env.MODEL_DEEP ?? 'openai/gpt-6.1-sol',
};
