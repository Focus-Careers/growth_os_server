import cron from 'node-cron';
import { getSupabaseAdmin } from '../config/supabase.js';
import { dispatchSkill } from '../employees/index.js';
import { reconcileCampaignSends } from '../lib/smartlead/reconcile_sends.js';

const jobs = new Map(); // cronId -> node-cron task

// Smartlead doesn't fire EMAIL_SENT webhooks for follow-up sends, so we poll the
// statistics API on a fixed schedule to keep send counts + sequence progress accurate.
const RECONCILE_CRON = '0 */8 * * *'; // every 8 hours

export async function reconcileAllCampaigns() {
  const supabase = getSupabaseAdmin();
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id')
    .not('smartlead_campaign_id', 'is', null);

  console.log(`[cronService] Reconciling sends for ${(campaigns ?? []).length} campaign(s)`);
  for (const c of campaigns ?? []) {
    try {
      await reconcileCampaignSends(c.id);
    } catch (err) {
      console.error(`[cronService] reconcile error for ${c.id}:`, err.message);
    }
    // Space out calls to stay under Smartlead's rate limit
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

async function runCampaigns(cronId, campaignIds) {
  console.log(`[cronService] Job fired: cron ${cronId}, campaigns: ${campaignIds.join(', ')}`);
  const supabase = getSupabaseAdmin();
  for (const campaign_id of campaignIds) {
    const { data: campaign } = await supabase
      .from('campaigns').select('account_id, itp_id').eq('id', campaign_id).single();
    if (!campaign?.itp_id) continue;

    const { data: ud } = await supabase
      .from('user_details').select('id').eq('account_id', campaign.account_id).limit(1).single();
    if (!ud) continue;

    dispatchSkill('lead_gen_expert', 'target_finder_100_leads', {
      user_details_id: ud.id,
      itp_id: campaign.itp_id,
      campaign_id,
    }).catch(err => console.error(`[cronService] dispatch error for campaign ${campaign_id}:`, err));
  }

  await supabase
    .from('target_finder_crons')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', cronId);
}

function scheduleJob(cronRow) {
  if (!cron.validate(cronRow.cron_expression)) {
    console.warn(`[cronService] Invalid cron expression for job ${cronRow.id}: ${cronRow.cron_expression}`);
    return;
  }
  const options = cronRow.timezone ? { timezone: cronRow.timezone } : {};
  const task = cron.schedule(cronRow.cron_expression, () => runCampaigns(cronRow.id, cronRow.campaign_ids), options);
  jobs.set(cronRow.id, task);
}

export async function init() {
  const supabase = getSupabaseAdmin();
  const { data: crons } = await supabase
    .from('target_finder_crons').select('*').eq('active', true);
  (crons || []).forEach(scheduleJob);
  console.log(`[cronService] Loaded ${(crons || []).length} cron job(s)`);

  // Fixed schedule: poll Smartlead stats to reconcile send counts (webhooks miss follow-ups)
  cron.schedule(RECONCILE_CRON, () => {
    reconcileAllCampaigns().catch(err => console.error('[cronService] reconcile sweep error:', err));
  });
  console.log(`[cronService] Scheduled send reconciliation: ${RECONCILE_CRON}`);
}

export function addJob(cronRow) {
  scheduleJob(cronRow);
}

export function removeJob(id) {
  const task = jobs.get(id);
  if (task) {
    task.stop();
    jobs.delete(id);
  }
}

export function pauseJob(id) {
  const task = jobs.get(id);
  if (task) task.stop();
}

export function resumeJob(cronRow) {
  const existing = jobs.get(cronRow.id);
  if (existing) existing.stop();
  scheduleJob(cronRow);
}
