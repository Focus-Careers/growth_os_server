import { getAnthropic } from '../../config/anthropic.js';

const SYSTEM_PROMPT = `You are classifying email replies to cold outreach campaigns.

Given the reply text, classify it into exactly one category:
- positive: Interested, wants to learn more, agrees to a call, asks questions about the product/service
- negative: Not interested, asks to stop, hostile, explicit rejection
- neutral: Unclear intent, vague response, asks a question that doesn't indicate interest or disinterest
- out_of_office: Auto-reply, vacation notice, left the company, forwarded to someone else

Respond with ONLY the classification word. No explanation.`;

/**
 * Classify a reply email body into positive/negative/neutral/out_of_office.
 * @param {string} replyBody - The raw text of the reply email
 * @returns {Promise<'positive'|'negative'|'neutral'|'out_of_office'>}
 */
export async function classifyReply(replyBody) {
  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: replyBody }],
    });
    const raw = response.content[0].text.trim().toLowerCase();
    const valid = ['positive', 'negative', 'neutral', 'out_of_office'];
    return valid.includes(raw) ? raw : 'neutral';
  } catch (err) {
    console.error('[reply_classifier] error:', err.message);
    return 'neutral';
  }
}
