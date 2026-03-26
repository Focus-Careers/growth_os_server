import { getStepFromFlow } from '../step_loader.js';

export default async function handler(messages, context) {
  return getStepFromFlow('review_campaign', 'sender_setup');
}
