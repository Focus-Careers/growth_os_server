import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function hundredApprovedLeadsFound(messages) {
  const flow = await getFlowConfig('100_approved_leads_found');
  return getStepFromFlow('100_approved_leads_found', flow.start_id);
}
