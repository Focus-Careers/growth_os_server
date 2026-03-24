import { getStepFromFlow } from '../step_loader.js';

export default async function initiateTargetFinder(messages, context) {
  return getStepFromFlow('initiate_target_finder_ten_leads', 'initial_message');
}
