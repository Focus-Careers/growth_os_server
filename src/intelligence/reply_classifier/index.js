import { getOpenAI } from '../../config/openai.js';

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
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 16,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: replyBody },
      ],
    });
    const raw = response.choices[0].message.content.trim().toLowerCase();
    const valid = ['positive', 'negative', 'neutral', 'out_of_office'];
    return valid.includes(raw) ? raw : 'neutral';
  } catch (err) {
    console.error('[reply_classifier] error:', err.message);
    return 'neutral';
  }
}
