// -------------------------------------------------------------------------
// MOBILISATION DISPATCHER
// Maps mobilisation names (as returned by Claude) to their handler modules.
// To add a new mobilisation: import its index.js and register it below.
// -------------------------------------------------------------------------

import signUpNoAccount from './sign_up_no_account/index.js';
import signUpGetWebsite from './sign_up_get_website/index.js';
import signupIdealTargetProfile from './signup_ideal_target_profile/index.js';
import uploadCustomers from './upload_customers/index.js';
import signedUpFirstMessage from './signed_up_first_message/index.js';
import initiateTargetFinderTenLeads from './initiate_target_finder_ten_leads/index.js';
import needTenMoreLeads from './need_ten_more_leads/index.js';
import tenApprovedLeadsFound from './ten_approved_leads_found/index.js';
import tenSeventyPlusLeadsFound from './ten_70_plus_leads_found/index.js';
import hundredApprovedLeadsFound from './100_approved_leads_found/index.js';
import initiateCreateCampaign from './initiate_create_campaign/index.js';
import setupSender from './setup_sender/index.js';
import { getStepFromFlow, getFlowConfig } from './step_loader.js';
import { dispatchSkill } from '../employees/index.js';
import { getSupabaseAdmin } from '../config/supabase.js';

const mobilisations = {
  sign_up_no_account: signUpNoAccount,
  sign_up_get_website: signUpGetWebsite,
  signup_ideal_target_profile: signupIdealTargetProfile,
  upload_customers: uploadCustomers,
  signed_up_first_message: signedUpFirstMessage,
  initiate_target_finder_ten_leads: initiateTargetFinderTenLeads,
  need_ten_more_leads: needTenMoreLeads,
  ten_approved_leads_found: tenApprovedLeadsFound,
  ten_70_plus_leads_found: tenSeventyPlusLeadsFound,
  '100_approved_leads_found': hundredApprovedLeadsFound,
  initiate_create_campaign: initiateCreateCampaign,
  setup_sender: setupSender,
};

export async function triggerMobilisation(name, messages, context = {}) {
  const handler = mobilisations[name];
  if (!handler) throw new Error(`Unknown mobilisation: ${name}`);
  return handler(messages, context);
}

// -------------------------------------------------------------------------
// GET STEP
// Loads a specific step by ID from a mobilisation's flow.yaml.
// Called when the user progresses through a mobilisation mid-conversation.
// -------------------------------------------------------------------------
export async function getStep(mobilisationName, stepId, value = null, user_details_id = null) {
  if (!mobilisations[mobilisationName]) throw new Error(`Unknown mobilisation: ${mobilisationName}`);
  return getStepFromFlow(mobilisationName, stepId, value, user_details_id);
}

// -------------------------------------------------------------------------
// COMPLETE MOBILISATION
// Called when the frontend reaches end_flow. Reads on_complete from the
// flow.yaml, maps collected responses to skill inputs, and dispatches.
// -------------------------------------------------------------------------
export async function completeMobilisation(mobilisationName, responses, messages = [], user_details_id = null) {
  if (!mobilisations[mobilisationName]) throw new Error(`Unknown mobilisation: ${mobilisationName}`);

  const flow = await getFlowConfig(mobilisationName);
  const { on_complete } = flow;
  if (!on_complete) return null;

  if (on_complete.db_updates) {
    for (const update of on_complete.db_updates) {
      const matchValue = update.match_value === '@user_details_id' ? user_details_id : update.match_value;
      await getSupabaseAdmin()
        .from(update.table)
        .update(update.set)
        .eq(update.match_field, matchValue);
    }
  }

  if (on_complete.condition) {
    const { step, value } = on_complete.condition;
    console.log(`[completeMobilisation] condition check: responses["${step}"] = "${responses[step]}" vs "${value}" → ${responses[step] === value ? 'PASS' : 'FAIL'}`);
    if (responses[step] !== value) return null;
  }

  if (on_complete.mobilisation) {
    return { next_mobilisation: on_complete.mobilisation };
  }

  if (!on_complete.employee) return null;

  // Resolve @account. references by fetching the account record once if needed
  const inputValues = Object.values(on_complete.inputs);
  const needsAccount = inputValues.some(v => typeof v === 'string' && v.startsWith('@account.'));
  let account = null;
  if (needsAccount && user_details_id) {
    const { data: userDetails } = await getSupabaseAdmin()
      .from('user_details').select('account_id').eq('id', user_details_id).single();
    if (userDetails?.account_id) {
      const { data } = await getSupabaseAdmin()
        .from('account').select('*').eq('id', userDetails.account_id).single();
      account = data;
    }
  }

  // Map step_id responses (or @account. lookups) to skill input names
  const inputs = {};
  for (const [inputName, source] of Object.entries(on_complete.inputs)) {
    if (typeof source === 'string' && source.startsWith('@account.')) {
      const field = source.slice('@account.'.length);
      inputs[inputName] = account?.[field] ?? null;
    } else {
      inputs[inputName] = responses[source];
    }
  }
  inputs.messages = messages;
  inputs.user_details_id = user_details_id;

  if (on_complete.sync) {
    const result = await dispatchSkill(on_complete.employee, on_complete.skill, inputs);
    return result;
  }

  dispatchSkill(on_complete.employee, on_complete.skill, inputs)
    .catch(err => console.error('[completeMobilisation] skill dispatch error:', err));
  return { dispatched: true };
}
