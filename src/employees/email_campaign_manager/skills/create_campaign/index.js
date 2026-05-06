import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { fixSequenceDelays } from '../../../../utils/sequence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function executeSkill({ user_details_id, itp_id, campaign_name, num_emails, tone }) {
  // Guard: if required inputs are missing (e.g. user cancelled the flow), return early
  if (!campaign_name || !num_emails || !tone) {
    console.log('[create_campaign] Missing required inputs (campaign_name, num_emails, or tone) — skipping.');
    return { skipped: true };
  }

  const admin = getSupabaseAdmin();

  // Look up account
  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();
  if (!userDetails?.account_id) {
    console.error('[create_campaign] No account found for user', user_details_id);
    return { error: 'no_account' };
  }

  // Load ITP for context
  const { data: itp } = await admin
    .from('itp').select('*').eq('id', itp_id).single();
  if (!itp) {
    console.error('[create_campaign] ITP not found:', itp_id);
    return { error: 'itp_not_found' };
  }

  // Load account for context
  const { data: account } = await admin
    .from('account').select('*').eq('id', userDetails.account_id).single();

  // Use Claude to generate subject line and email template
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  const context = JSON.stringify({
    campaign_name,
    num_emails: parseInt(num_emails) || 1,
    tone,
    itp: {
      name: itp.name,
      summary: itp.itp_summary,
      demographics: itp.itp_demographic,
      pain_points: itp.itp_pain_points,
      buying_trigger: itp.itp_buying_trigger,
    },
    account: {
      name: account?.organisation_name,
      description: account?.description,
      problem_solved: account?.problem_solved,
      website: account?.organisation_website,
    },
  }, null, 2);

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5',
    max_completion_tokens: 2048,
    messages: [{ role: 'user', content: `${prompt}\n\nContext:\n${context}` }],
  });

  const raw = response.choices[0].message.content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let generated;
  try {
    generated = JSON.parse(raw);
  } catch (err) {
    console.error('[create_campaign] Failed to parse Claude response:', err.message, '| raw:', raw);
    generated = { sequence: [{ seq_number: 1, delay_in_days: 0, subject: `${campaign_name} - Introduction`, body: '<p>Hi {{first_name}},</p><p>I wanted to reach out...</p>' }] };
  }

  // Parse num_emails from the option message (e.g. "3 email sequence" -> 3)
  const emailCount = parseInt(num_emails) || 1;
  const sequence = fixSequenceDelays(generated.sequence ?? []);
  const firstEmail = sequence[0] ?? {};

  console.log(`[create_campaign] Generated ${sequence.length} email sequence`);

  // Insert campaign
  const { data: campaign, error: campaignError } = await admin
    .from('campaigns')
    .insert({
      account_id: userDetails.account_id,
      itp_id,
      name: campaign_name,
      status: 'draft',
      num_emails: emailCount,
      tone,
      subject_line: firstEmail.subject ?? campaign_name,
      email_template: firstEmail.body ?? '',
      email_sequence: sequence,
    })
    .select('id')
    .single();

  if (campaignError) {
    console.error('[create_campaign] Insert error:', campaignError);
    return { error: 'insert_failed' };
  }

  // Auto-populate campaign_contacts from approved leads with contacts
  // First get approved leads for this ITP
  const { data: approvedLeads } = await admin
    .from('leads')
    .select('target_id')
    .eq('itp_id', itp_id)
    .eq('approved', true);

  const approvedTargetIds = (approvedLeads ?? []).map(l => l.target_id);

  if (approvedTargetIds.length) {
    // Get contacts for those targets
    const { data: contacts } = await admin
      .from('contacts')
      .select('id')
      .in('target_id', approvedTargetIds);

    if (contacts?.length) {
      const { error: ccError } = await admin
        .from('campaign_contacts')
        .insert(contacts.map(c => ({
          campaign_id: campaign.id,
          contact_id: c.id,
        })));
      if (ccError) console.error('[create_campaign] campaign_contacts insert error:', ccError);
    }
  }

  // Count contacts added
  const { count } = await admin
    .from('campaign_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id);

  await processSkillOutput({
    employee: 'email_campaign_manager',
    skill_name: 'create_campaign',
    user_details_id,
    output: {
      campaign_id: campaign.id,
      campaign_name,
      subject_line: firstEmail.subject ?? campaign_name,
      email_template: firstEmail.body ?? '',
      email_sequence: sequence,
      num_emails: emailCount,
      tone,
      contact_count: count ?? 0,
    },
  });

  return { campaign_id: campaign.id };
}
