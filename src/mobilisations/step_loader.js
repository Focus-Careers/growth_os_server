// -------------------------------------------------------------------------
// STEP LOADER
// Generic utility that reads a mobilisation's flow.yaml and returns
// a single step by ID, formatted for the frontend.
// For validate type steps, runs checks and returns the resolved next step.
// -------------------------------------------------------------------------

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { checks } from './checks.js';
import { getOpenAI } from '../config/openai.js';
import { getSupabaseAdmin } from '../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function getFlowConfig(mobilisationName) {
  const flowPath = join(__dirname, mobilisationName, 'flow.yaml');
  const raw = await readFile(flowPath, 'utf-8');
  return yaml.load(raw);
}

function formatStep(step) {
  const messages = step.messages ?? (step.agent_message_body ? [step.agent_message_body] : []);
  const options = step.options
    ? step.options.map(o => ({ id: o.id, message: o.message, next_id: o.next_id ?? null }))
    : null;
  return {
    id: step.id,
    type: step.type,
    messages,
    options,
    next_id: step.next_id ?? null,
    response_key: step.response_key ?? null,
    sidebar: step.sidebar ?? null,
  };
}

async function resolveVariables(messages, user_details_id) {
  const needsCustomerCount = messages.some(m => m.includes('{{count_customers_with_account_id}}'));
  const needsFirstName = messages.some(m => m.includes('{{user_first_name}}'));
  const needsOrgName = messages.some(m => m.includes('{{organisation_name}}'));
  if (!needsCustomerCount && !needsFirstName && !needsOrgName) return messages;

  let result = [...messages];

  // Fetch user_details once for all variable types that need it
  const { data: userDetails } = await getSupabaseAdmin()
    .from('user_details').select('account_id, firstname').eq('id', user_details_id).single();

  if (needsCustomerCount) {
    const { count } = await getSupabaseAdmin()
      .from('customers').select('*', { count: 'exact', head: true })
      .eq('account_id', userDetails?.account_id ?? '');
    result = result.map(m => m.replace('{{count_customers_with_account_id}}', count ?? 0));
  }

  if (needsFirstName) {
    result = result.map(m => m.replace('{{user_first_name}}', userDetails?.firstname ?? ''));
  }

  if (needsOrgName) {
    const { data: account } = await getSupabaseAdmin()
      .from('account').select('organisation_name').eq('id', userDetails?.account_id ?? '').single();
    result = result.map(m => m.replace('{{organisation_name}}', account?.organisation_name ?? 'your company'));
  }

  return result;
}

export async function getStepFromFlow(mobilisationName, stepId, value = null, user_details_id = null) {
  const flow = await getFlowConfig(mobilisationName);
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in ${mobilisationName} flow`);

  // Validate steps are resolved server-side and never sent directly to the frontend
  if (step.type === 'validate') {
    for (const { check, on_fail } of step.checks) {
      const fn = checks[check];
      if (!fn) throw new Error(`Unknown check: ${check}`);
      const passed = await fn(value);
      if (!passed) {
        const failStep = flow.steps.find(s => s.id === on_fail);
        if (!failStep) throw new Error(`Step "${on_fail}" not found in ${mobilisationName} flow`);
        return formatStep(failStep);
      }
    }
    // All checks passed — return on_pass step
    const passStep = flow.steps.find(s => s.id === step.on_pass);
    if (!passStep) throw new Error(`Step "${step.on_pass}" not found in ${mobilisationName} flow`);
    return formatStep(passStep);
  }

  if (step.type === 'ai_message' || step.type === 'ai_message_with_options') {
    const promptPath = join(__dirname, mobilisationName, step.prompt_file);
    const prompt = await readFile(promptPath, 'utf-8');
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-nano',
      max_completion_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });
    const generatedMessage = response.choices[0].message.content.trim();
    return { ...formatStep(step), messages: [generatedMessage] };
  }

  const formatted = formatStep(step);
  if (user_details_id && formatted.messages?.length) {
    formatted.messages = await resolveVariables(formatted.messages, user_details_id);
  }
  return formatted;
}
