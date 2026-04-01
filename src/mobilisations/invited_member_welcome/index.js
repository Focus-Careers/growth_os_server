import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function invitedMemberWelcome(messages, context = {}) {
  const flow = await getFlowConfig('invited_member_welcome');
  return getStepFromFlow('invited_member_welcome', flow.start_id, null, context.user_details_id ?? null);
}
