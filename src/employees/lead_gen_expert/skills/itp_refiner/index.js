import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { dispatchSkill } from '../../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function executeSkill({ user_details_id, itp_id, user_feedback, skip_target_finder = false }) {
  const admin = getSupabaseAdmin();

  // Resolve ITP: use provided id, or fall back to most recent for the account
  let resolvedItpId = itp_id;
  if (!resolvedItpId && user_details_id) {
    const { data: ud } = await admin.from('user_details').select('account_id').eq('id', user_details_id).single();
    if (ud?.account_id) {
      const { data: latestItp } = await admin.from('itp').select('id').eq('account_id', ud.account_id).order('created_at', { ascending: false }).limit(1).single();
      resolvedItpId = latestItp?.id;
    }
  }

  // Load the current ITP
  const { data: itp } = await admin.from('itp').select('*').eq('id', resolvedItpId).single();
  if (!itp) throw new Error(`ITP not found: ${resolvedItpId}`);

  // Load all rejected leads with reasons for this ITP, joining target data
  const { data: rejectedLeads } = await admin
    .from('leads')
    .select('id, target_id, score, score_reason, rejection_reason, targets(title, link, industry, employee_count, company_description, company_location)')
    .eq('itp_id', resolvedItpId)
    .eq('rejected', true)
    .not('rejection_reason', 'is', null);

  const rejections = (rejectedLeads ?? []).filter(l => l.rejection_reason?.trim());

  if (rejections.length === 0 && !user_feedback) {
    console.log('[itp_refiner] No rejection reasons or user feedback found, skipping refinement');
    if (!skip_target_finder) {
      dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id: resolvedItpId })
        .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
    }
    return { refined: false, itp_id: resolvedItpId };
  }

  // Load the prompt
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  // Build context for Claude
  const context = JSON.stringify({
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
      company_description: l.targets?.company_description ?? null,
      location: l.targets?.company_location ?? null,
      score: l.score,
      score_reason: l.score_reason,
      user_rejection_reason: l.rejection_reason,
    })),
    ...(user_feedback ? { user_feedback_from_chat: user_feedback } : {}),
  }, null, 2);

  console.log(`[itp_refiner] Refining ITP ${resolvedItpId} based on ${rejections.length} rejection(s)${user_feedback ? ` + user feedback: "${user_feedback}"` : ''}`);

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5-mini',
    max_completion_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\nContext:\n${context}` }],
  });

  const raw = response.choices[0].message.content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let refined;
  try {
    refined = JSON.parse(raw);
  } catch (err) {
    console.error('[itp_refiner] Failed to parse Claude response:', err.message, '| raw:', raw);
    if (!skip_target_finder) {
      dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id: resolvedItpId })
        .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
    }
    return { refined: false, itp_id: resolvedItpId };
  }

  // Update the ITP in the database
  const updateFields = {};
  if (refined.name) updateFields.name = refined.name;
  if (refined.itp_summary) updateFields.itp_summary = refined.itp_summary;
  if (refined.demographics) updateFields.itp_demographic = refined.demographics;
  if (refined.pain_points) updateFields.itp_pain_points = refined.pain_points;
  if (refined.buying_trigger) updateFields.itp_buying_trigger = refined.buying_trigger;
  if (refined.location) updateFields.location = refined.location;

  if (Object.keys(updateFields).length > 0) {
    const { error } = await admin.from('itp').update(updateFields).eq('id', resolvedItpId);
    if (error) console.error('[itp_refiner] ITP update error:', error);
    else console.log('[itp_refiner] ITP updated successfully');
  }

  if (!skip_target_finder) {
    await processSkillOutput({
      employee: 'lead_gen_expert',
      skill_name: 'itp_refiner',
      user_details_id,
      output: {
        itp_id: resolvedItpId,
        rejection_count: rejections.length,
        changes_summary: refined.changes_summary ?? 'ITP updated based on your feedback.',
      },
    });

    console.log('[itp_refiner] Triggering target_finder_ten_leads with refined ITP');
    dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id: resolvedItpId })
      .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
  }

  return { refined: true, itp_id: resolvedItpId, changes_summary: refined.changes_summary ?? null };
}
