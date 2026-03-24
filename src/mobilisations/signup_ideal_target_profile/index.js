import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function signupIdealTargetProfile() {
  const flow = await getFlowConfig('signup_ideal_target_profile');
  return getStepFromFlow('signup_ideal_target_profile', flow.start_id);
}
