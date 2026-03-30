import { getFlowConfig, getStepFromFlow } from '../step_loader.js';

export default async function initiateItpRefiner(messages) {
  const flow = await getFlowConfig('initiate_itp_refiner');
  return getStepFromFlow('initiate_itp_refiner', flow.start_id);
}
