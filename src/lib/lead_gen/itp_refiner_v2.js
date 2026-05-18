import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';
import { getSupabaseAdmin } from '../../config/supabase.js';
import { clearQueryProfileCache } from './query_generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CYCLES_BEFORE_ESCALATION = 5;
const STABLE_REJECTION_THRESHOLD = 3; // cycles with semantically similar rejections → escalate

/**
 * Refine an ITP based on rejection patterns and optional user feedback.
 * Produces a structured diff rather than a full rewrite.
 * Clears the search profile cache so the next run generates fresh queries.
 * Increments the refinement_cycle_count on the ITP.
 * Stores the diff in itp_refinement_history.
 *
 * @param {object} params
 * @param {string}   params.itp_id
 * @param {string}   [params.user_feedback]
 * @param {boolean}  [params.skip_target_finder] - If true, don't dispatch target_finder after refinement
 *
 * @returns {Promise<{
 *   refined: boolean,
 *   itp_id: string,
 *   changes_summary: string|null,
 *   should_escalate: boolean,
 *   escalation_reason: string|null,
 *   cycle_number: number,
 * }>}
 */
export async function refineItp({ itp_id, user_feedback }) {
  const admin = getSupabaseAdmin();

  const { data: itp } = await admin.from('itp').select('*').eq('id', itp_id).single();
  if (!itp) throw new Error(`itp_refiner_v2: ITP not found: ${itp_id}`);

  // Load all rejected leads with reasons
  const { data: rejectedLeads } = await admin
    .from('leads')
    .select('id, target_id, score, score_reason, rejection_reason, targets(title, link, industry, employee_count, company_description, company_location)')
    .eq('itp_id', itp_id)
    .eq('rejected', true)
    .not('rejection_reason', 'is', null);

  const rejections = (rejectedLeads ?? []).filter(l => l.rejection_reason?.trim());

  if (rejections.length === 0 && !user_feedback) {
    console.log('[itp_refiner_v2] No rejections or feedback — skipping refinement');
    return { refined: false, itp_id, changes_summary: null, should_escalate: false, escalation_reason: null, cycle_number: itp.refinement_cycle_count ?? 0 };
  }

  const cycleNumber = (itp.refinement_cycle_count ?? 0) + 1;

  const prompt = await readFile(join(__dirname, 'prompts/prompt_itp_refine_v2.md'), 'utf-8');

  const context = {
    current_cycle: cycleNumber,
    current_itp: {
      name: itp.name,
      summary: itp.itp_summary,
      demographics: itp.itp_demographic,
      pain_points: itp.itp_pain_points,
      buying_trigger: itp.itp_buying_trigger,
      location: itp.location,
    },
    rejections: rejections.map(l => ({
      company: l.targets?.title,
      url: l.targets?.link,
      industry: l.targets?.industry ?? null,
      employee_count: l.targets?.employee_count ?? null,
      description: l.targets?.company_description ?? null,
      location: l.targets?.company_location ?? null,
      score: l.score,
      score_reason: l.score_reason,
      user_rejection_reason: l.rejection_reason,
    })),
    ...(user_feedback ? { user_feedback } : {}),
  };

  console.log(`[itp_refiner_v2] Refining ITP ${itp_id} — cycle ${cycleNumber}, ${rejections.length} rejection(s)`);

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 1024,
      messages: [{ role: 'user', content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}` }],
    });
  } catch (err) {
    console.error('[itp_refiner_v2] LLM error:', err.message);
    return { refined: false, itp_id, changes_summary: null, should_escalate: false, escalation_reason: null, cycle_number: cycleNumber };
  }

  const raw = response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  let result;
  try {
    result = JSON.parse(raw);
  } catch (err) {
    console.error('[itp_refiner_v2] Parse error:', raw.slice(0, 300));
    return { refined: false, itp_id, changes_summary: null, should_escalate: false, escalation_reason: null, cycle_number: cycleNumber };
  }

  // Force escalation if we've hit cycle limit regardless of model suggestion
  if (cycleNumber >= MAX_CYCLES_BEFORE_ESCALATION) {
    result.should_escalate = true;
    result.escalation_reason = result.escalation_reason
      ?? `This ITP has been refined ${cycleNumber} times. The search keeps producing similar results — we need your help to clarify what makes the difference.`;
  }

  // Apply the diff to the ITP
  const diff = result.diff ?? {};
  const updateFields = {};

  if (diff.itp_summary) updateFields.itp_summary = diff.itp_summary;
  if (diff.itp_demographic) updateFields.itp_demographic = diff.itp_demographic;
  if (diff.itp_pain_points) updateFields.itp_pain_points = diff.itp_pain_points;
  if (diff.itp_buying_trigger) updateFields.itp_buying_trigger = diff.itp_buying_trigger;
  if (diff.location) updateFields.location = diff.location;

  updateFields.refinement_cycle_count = cycleNumber;

  if (Object.keys(updateFields).length > 0) {
    const { error } = await admin.from('itp').update(updateFields).eq('id', itp_id);
    if (error) console.error('[itp_refiner_v2] ITP update error:', error.message);
  }

  // Clear cached search profile — the refined ITP needs fresh queries
  await clearQueryProfileCache(itp_id);

  // Store diff in history table
  await admin.from('itp_refinement_history').insert({
    itp_id,
    cycle_number: cycleNumber,
    diff,
    rejection_reasons_digest: rejections.map(r => r.user_rejection_reason).join(' | ').slice(0, 500),
    user_feedback: user_feedback ?? null,
  });

  console.log(`[itp_refiner_v2] Cycle ${cycleNumber} complete — escalate: ${result.should_escalate}`);

  return {
    refined: true,
    itp_id,
    changes_summary: result.changes_summary ?? 'ITP updated based on feedback.',
    should_escalate: result.should_escalate ?? false,
    escalation_reason: result.escalation_reason ?? null,
    cycle_number: cycleNumber,
    rejection_pattern_summary: result.rejection_pattern_summary ?? null,
  };
}
