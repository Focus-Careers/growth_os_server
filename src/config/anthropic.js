import Anthropic from '@anthropic-ai/sdk';

let client = null;

export function getAnthropic() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
