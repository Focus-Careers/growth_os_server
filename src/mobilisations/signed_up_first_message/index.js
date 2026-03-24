import { getStepFromFlow } from '../step_loader.js';

export default async function signedUpFirstMessage() {
  return getStepFromFlow('signed_up_first_message', 'time_to_start');
}
