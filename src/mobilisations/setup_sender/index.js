import { getStepFromFlow } from '../step_loader.js';

export default async function handler(messages, context) {
  return getStepFromFlow('setup_sender', 'intro');
}
