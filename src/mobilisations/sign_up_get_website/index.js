import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function signUpGetWebsite() {
  const flow = await getFlowConfig('sign_up_get_website');
  return getStepFromFlow('sign_up_get_website', flow.start_id);
}
