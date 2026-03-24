import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function needTenMoreLeads(messages) {
  const flow = await getFlowConfig('need_ten_more_leads');
  return getStepFromFlow('need_ten_more_leads', flow.start_id);
}
