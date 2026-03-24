import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function tenApprovedLeadsFound(messages) {
  const flow = await getFlowConfig('ten_approved_leads_found');
  return getStepFromFlow('ten_approved_leads_found', flow.start_id);
}
