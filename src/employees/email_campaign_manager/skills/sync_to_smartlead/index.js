import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import {
  createCampaign as slCreateCampaign,
  saveSequences,
  setSchedule,
  setCampaignSettings,
  attachEmailAccount,
  addLeads,
  registerCampaignWebhook,
} from '../../../../config/smartlead.js';
import { resolveSmartleadSender } from '../../helpers/resolve_smartlead_sender.js';

export async function executeSkill({ user_details_id, campaign_id }) {
  const admin = getSupabaseAdmin();

  console.log(`[sync_to_smartlead] Starting sync for campaign ${campaign_id}`);

  // Atomic dedup: claim the sync by setting a placeholder, skip if already claimed
  const { data: claimed } = await admin
    .from('campaigns')
    .update({ smartlead_campaign_id: 'syncing' })
    .eq('id', campaign_id)
    .is('smartlead_campaign_id', null)
    .select('id')
    .single();

  if (!claimed) {
    console.log(`[sync_to_smartlead] Campaign ${campaign_id} already syncing or synced, skipping`);
    return { campaign_id, skipped: true };
  }

  // Load campaign
  const { data: campaign } = await admin
    .from('campaigns')
    .select('*')
    .eq('id', campaign_id)
    .single();

  if (!campaign) throw new Error(`Campaign not found: ${campaign_id}`);

  // ── Step 1: Create Smartlead campaign ──────────────────────────────
  const slCampaign = await slCreateCampaign(campaign.name);
  if (!slCampaign?.id) {
    console.error('[sync_to_smartlead] Failed to create Smartlead campaign');
    return { error: 'smartlead_campaign_create_failed' };
  }

  const slCampaignId = slCampaign.id;

  // Save Smartlead campaign ID to our DB
  await admin.from('campaigns')
    .update({ smartlead_campaign_id: String(slCampaignId) })
    .eq('id', campaign_id);

  // ── Step 2: Save email sequences ───────────────────────────────────
  let sequences = campaign.email_sequence;
  if (!sequences || !Array.isArray(sequences) || sequences.length === 0) {
    // Fallback: use subject_line + email_template as single sequence
    sequences = [{
      seq_number: 1,
      delay_in_days: 0,
      subject: campaign.subject_line ?? campaign.name,
      body: campaign.email_template ?? '<p>Hi {{first_name}},</p><p>I wanted to reach out...</p>',
    }];
  }

  await saveSequences(slCampaignId, sequences);

  // ── Step 3: Set schedule ───────────────────────────────────────────
  await setSchedule(slCampaignId, campaign.schedule ?? {});

  // ── Step 4: Configure settings ─────────────────────────────────────
  await setCampaignSettings(slCampaignId);

  // ── Step 4b: Register webhook ──────────────────────────────────────
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  if (webhookBaseUrl) {
    await registerCampaignWebhook(slCampaignId, `${webhookBaseUrl}/api/webhooks/smartlead`);
  } else {
    console.warn('[sync_to_smartlead] WEBHOOK_BASE_URL not set, skipping webhook registration');
  }

  // ── Step 5: Attach email account ───────────────────────────────────
  if (campaign.sender_id) {
    const { slEmailAccountId } = await resolveSmartleadSender(campaign.sender_id);
    if (slEmailAccountId) {
      await attachEmailAccount(slCampaignId, parseInt(slEmailAccountId));
    }
  } else {
    console.log('[sync_to_smartlead] No sender_id on campaign, skipping email account setup');
  }

  // ── Step 6: Push leads (contacts) ──────────────────────────────────
  const { data: campaignContacts } = await admin
    .from('campaign_contacts')
    .select('id, contact_id, contacts(first_name, last_name, email, role, phone, linkedin_url, target_id, targets(title, domain, company_location, industry))')
    .eq('campaign_id', campaign_id)
    .eq('smartlead_synced', false);

  if (campaignContacts?.length) {
    // Map to Smartlead lead format
    const leads = campaignContacts
      .filter(cc => cc.contacts?.email)
      .map(cc => ({
        email: cc.contacts.email,
        first_name: cc.contacts.first_name ?? '',
        last_name: cc.contacts.last_name ?? '',
        company_name: cc.contacts.targets?.title ?? '',
        website: cc.contacts.targets?.domain ? `https://${cc.contacts.targets.domain}` : '',
        linkedin_profile: cc.contacts.linkedin_url ?? '',
        location: cc.contacts.targets?.company_location ?? '',
        custom_fields: {
          job_title: cc.contacts.role ?? '',
          industry: cc.contacts.targets?.industry ?? '',
        },
      }));

    // Push in batches of 100
    for (let i = 0; i < leads.length; i += 100) {
      const batch = leads.slice(i, i + 100);
      await addLeads(slCampaignId, batch);
    }

    // Mark as synced
    const syncedIds = campaignContacts.map(cc => cc.id);
    await admin.from('campaign_contacts')
      .update({ smartlead_synced: true })
      .in('id', syncedIds);

    console.log(`[sync_to_smartlead] Pushed ${leads.length} leads to Smartlead`);
  }

  // ── NOTE: NOT activating campaign (testing mode) ───────────────────
  // In production, uncomment:
  // await updateCampaignStatus(slCampaignId, 'ACTIVE');
  console.log(`[sync_to_smartlead] Campaign synced to Smartlead (id=${slCampaignId}) — NOT activated (testing mode)`);

  await processSkillOutput({
    employee: 'email_campaign_manager',
    skill_name: 'sync_to_smartlead',
    user_details_id,
    output: {
      campaign_id,
      smartlead_campaign_id: slCampaignId,
      leads_pushed: campaignContacts?.length ?? 0,
      status: 'synced_not_active',
    },
  });

  return { campaign_id, smartlead_campaign_id: slCampaignId };
}
