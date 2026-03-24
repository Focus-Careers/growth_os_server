import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function tenSeventyPlusLeadsFound(messages) {
  const flow = await getFlowConfig('ten_70_plus_leads_found');
  return getStepFromFlow('ten_70_plus_leads_found', flow.start_id);
}
