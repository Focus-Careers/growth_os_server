import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { dispatchSkill } from '../../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function executeSkill({ user_details_id, itp_id }) {
  const admin = getSupabaseAdmin();

  // Load the current ITP
  const { data: itp } = await admin.from('itp').select('*').eq('id', itp_id).single();
  if (!itp) throw new Error(`ITP not found: ${itp_id}`);

  // Load all rejected leads with reasons for this ITP, joining target data
  const { data: rejectedLeads } = await admin
    .from('leads')
    .select('id, target_id, score, score_reason, rejection_reason, targets(title, link)')
    .eq('itp_id', itp_id)
    .eq('rejected', true)
    .not('rejection_reason', 'is', null);

  const rejections = (rejectedLeads ?? []).filter(l => l.rejection_reason?.trim());

  if (rejections.length === 0) {
    console.log('[itp_refiner] No rejection reasons found, skipping refinement');
    // Just trigger target finder to find more
    dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id })
      .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
    return { refined: false, itp_id };
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
      score: l.score,
      score_reason: l.score_reason,
      user_rejection_reason: l.rejection_reason,
    })),
  }, null, 2);

  console.log(`[itp_refiner] Refining ITP ${itp_id} based on ${rejections.length} rejection(s)`);

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\nContext:\n${context}` }],
  });

  const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let refined;
  try {
    refined = JSON.parse(raw);
  } catch (err) {
    console.error('[itp_refiner] Failed to parse Claude response:', err.message, '| raw:', raw);
    // Fall back to just triggering target finder without refinement
    dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id })
      .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));
    return { refined: false, itp_id };
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
    const { error } = await admin.from('itp').update(updateFields).eq('id', itp_id);
    if (error) console.error('[itp_refiner] ITP update error:', error);
    else console.log('[itp_refiner] ITP updated successfully');
  }

  // Send output to skill_output_processor
  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'itp_refiner',
    user_details_id,
    output: {
      itp_id,
      rejection_count: rejections.length,
      changes_summary: refined.changes_summary ?? 'ITP updated based on your feedback.',
    },
  });

  // Trigger target finder to find new targets with the refined ITP
  console.log('[itp_refiner] Triggering target_finder_ten_leads with refined ITP');
  dispatchSkill('lead_gen_expert', 'target_finder_ten_leads', { user_details_id, itp_id })
    .catch(err => console.error('[itp_refiner] target_finder dispatch error:', err));

  return { refined: true, itp_id };
}
