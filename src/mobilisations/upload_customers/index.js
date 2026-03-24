import { getStepFromFlow } from '../step_loader.js';

export default async function uploadCustomers() {
  return getStepFromFlow('upload_customers', 'intro');
}
