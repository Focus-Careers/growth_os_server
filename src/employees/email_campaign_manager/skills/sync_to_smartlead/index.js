import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import {
  createCampaign as slCreateCampaign,
  saveSequences,
  setSchedule,
  setCampaignSettings,
  getEmailAccounts,
  createEmailAccount,
  attachEmailAccount,
  addLeads,
  registerCampaignWebhook,
} from '../../../../config/smartlead.js';

export async function executeSkill({ user_details_id, campaign_id }) {
  const admin = getSupabaseAdmin();

  console.log(`[sync_to_smartlead] Starting sync for campaign ${campaign_id}`);

  // Load campaign
  const { data: campaign } = await admin
    .from('campaigns')
    .select('*')
    .eq('id', campaign_id)
    .single();

  if (!campaign) throw new Error(`Campaign not found: ${campaign_id}`);

  // Dedup: skip if already synced to Smartlead
  if (campaign.smartlead_campaign_id) {
    console.log(`[sync_to_smartlead] Campaign ${campaign_id} already synced (smartlead_id=${campaign.smartlead_campaign_id}), skipping`);
    return { campaign_id, smartlead_campaign_id: campaign.smartlead_campaign_id, skipped: true };
  }

  // Load sender
  const { data: sender } = campaign.sender_id
    ? await admin.from('senders').select('*').eq('id', campaign.sender_id).single()
    : { data: null };

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
  console.log(`[sync_to_smartlead] Sender:`, sender ? `id=${sender.id} email=${sender.email} smtp_host=${sender.smtp_host} sl_account=${sender.smartlead_email_account_id}` : 'NO SENDER (sender_id is null)');

  if (sender) {
    let slEmailAccountId = sender.smartlead_email_account_id;

    if (!slEmailAccountId) {
      // Check if this email already exists in Smartlead
      const existingAccounts = await getEmailAccounts();
      const existing = existingAccounts.find(a => a.from_email === sender.email);

      if (existing) {
        slEmailAccountId = String(existing.id);
      } else if (sender.smtp_host && sender.smtp_password) {
        // Create new email account in Smartlead
        const newAccount = await createEmailAccount({
          from_name: sender.display_name ?? sender.email,
          from_email: sender.email,
          smtp_host: sender.smtp_host,
          smtp_port: sender.smtp_port ?? 587,
          smtp_username: sender.smtp_username ?? sender.email,
          smtp_password: sender.smtp_password,
          imap_host: sender.imap_host,
          imap_port: sender.imap_port ?? 993,
          max_email_per_day: 50,
        });
        if (newAccount?.id) {
          slEmailAccountId = String(newAccount.id);
        }
      } else {
        console.warn('[sync_to_smartlead] Sender has no SMTP details, skipping email account setup');
      }

      // Save Smartlead email account ID to our DB
      if (slEmailAccountId) {
        await admin.from('senders')
          .update({ smartlead_email_account_id: slEmailAccountId })
          .eq('id', sender.id);
      }
    }

    if (slEmailAccountId) {
      await attachEmailAccount(slCampaignId, parseInt(slEmailAccountId));
    }
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
