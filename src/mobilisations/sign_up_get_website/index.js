import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function signUpGetWebsite(messages, context = {}) {
  const flow = await getFlowConfig('sign_up_get_website');
  const startId = context.start_step ?? flow.start_id;
  return getStepFromFlow('sign_up_get_website', startId, null, context.user_details_id ?? null);
}
