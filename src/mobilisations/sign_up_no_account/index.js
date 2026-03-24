// -------------------------------------------------------------------------
// MOBILISATION: sign_up_no_account
// Reads flow.yaml, finds the first step via start_id, and returns it
// to be included in the signup_processor response.
// -------------------------------------------------------------------------

import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function signUpNoAccount(messages) {
  const flow = await getFlowConfig('sign_up_no_account');
  return getStepFromFlow('sign_up_no_account', flow.start_id);
}
