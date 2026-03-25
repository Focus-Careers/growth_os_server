import { getStepFromFlow } from '../step_loader.js';

export default async function handler(messages, context) {
  return getStepFromFlow('initiate_create_campaign', 'intro');
}
