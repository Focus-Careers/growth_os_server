import express from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { attachEmailAccount, updateCampaignStatus, saveSequences } from '../config/smartlead.js';
import { resolveSmartleadSender } from '../employees/email_campaign_manager/helpers/resolve_smartlead_sender.js';
import { resolveCampaignSenders } from '../employees/email_campaign_manager/helpers/resolve_campaign_senders.js';
import { dispatchSkill } from '../employees/index.js';
import { fixSequenceDelays } from '../utils/sequence.js';
import { estimateCapacity } from '../utils/warmup_capacity.js';

const router = express.Router();

/**
 * POST /api/campaigns/update-sender
 * Updates the sender on a campaign and re-attaches in Smartlead if synced.
 */
router.post('/update-sender', async (req, res) => {
  const { campaign_id, sender_id } = req.body;
  if (!campaign_id || !sender_id) {
    return res.status(400).json({ error: 'campaign_id and sender_id required' });
  }

  const admin = getSupabaseAdmin();

  try {
    // Update sender_id in our DB (legacy field — keep for back-compat)
    const { error: updateError } = await admin
      .from('campaigns')
      .update({ sender_id })
      .eq('id', campaign_id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update campaign sender', detail: updateError.message });
    }

    // Mirror into campaign_senders junction
    await admin.from('campaign_senders').delete().eq('campaign_id', campaign_id);
    await admin.from('campaign_senders').insert({ campaign_id, sender_id });

    // Check if campaign is synced to Smartlead
    const { data: campaign } = await admin
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', campaign_id)
      .single();

    if (campaign?.smartlead_campaign_id && campaign.smartlead_campaign_id !== 'syncing') {
      // Resolve sender to Smartlead email account
      const { slEmailAccountId } = await resolveSmartleadSender(sender_id);

      if (slEmailAccountId) {
        await attachEmailAccount(parseInt(campaign.smartlead_campaign_id), parseInt(slEmailAccountId));
        console.log(`[update-sender] Re-attached sender ${sender_id} (SL account ${slEmailAccountId}) to SL campaign ${campaign.smartlead_campaign_id}`);
      } else {
        console.warn(`[update-sender] Could not resolve Smartlead account for sender ${sender_id}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[update-sender] Error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * POST /api/campaigns/toggle-status
 * Pause or resume a campaign. Syncs to Smartlead if connected.
 */
router.post('/toggle-status', async (req, res) => {
  const { campaign_id, status } = req.body;
  if (!campaign_id || !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'campaign_id and status (active|paused) required' });
  }

  const admin = getSupabaseAdmin();

  try {
    const { data: campaign } = await admin
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', campaign_id)
      .single();

    await admin
      .from('campaigns')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', campaign_id);

    // Sync to Smartlead if campaign is connected
    if (campaign?.smartlead_campaign_id && campaign.smartlead_campaign_id !== 'syncing') {
      if (status === 'paused') {
        // Always honour an explicit user pause
        await updateCampaignStatus(parseInt(campaign.smartlead_campaign_id), 'PAUSED');
        console.log(`[toggle-status] Campaign ${campaign_id} → paused (Smartlead: PAUSED)`);
      } else {
        // Only start in Smartlead if admin hasn't globally paused sending
        const { data: config } = await admin.from('smartlead_config').select('sending_paused').eq('id', 1).single();
        if (!config?.sending_paused) {
          await updateCampaignStatus(parseInt(campaign.smartlead_campaign_id), 'START');
          console.log(`[toggle-status] Campaign ${campaign_id} → active (Smartlead: START)`);
        } else {
          console.log(`[toggle-status] Campaign ${campaign_id} → active in DB only (Smartlead globally paused)`);
        }
      }
    }

    res.json({ success: true, status });
  } catch (err) {
    console.error('[toggle-status] Error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * POST /api/campaigns/update
 * Update campaign fields (name, tone, subject lines, email sequence).
 * Re-syncs sequences to Smartlead if connected.
 */
router.post('/update', async (req, res) => {
  const { campaign_id, name, tone, email_sequence } = req.body;
  if (!campaign_id) {
    return res.status(400).json({ error: 'campaign_id required' });
  }

  const admin = getSupabaseAdmin();

  try {
    const updateFields = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateFields.name = name;
    if (tone !== undefined) updateFields.tone = tone;
    if (email_sequence !== undefined) {
      const fixedSequence = fixSequenceDelays(email_sequence);
      updateFields.email_sequence = fixedSequence;
      updateFields.subject_line = fixedSequence[0]?.subject ?? null;
      updateFields.email_template = fixedSequence[0]?.body ?? null;
    }

    await admin.from('campaigns').update(updateFields).eq('id', campaign_id);

    // Re-sync sequences to Smartlead if connected
    if (email_sequence !== undefined) {
      const { data: campaign } = await admin
        .from('campaigns')
        .select('smartlead_campaign_id')
        .eq('id', campaign_id)
        .single();

      if (campaign?.smartlead_campaign_id && campaign.smartlead_campaign_id !== 'syncing') {
        await saveSequences(parseInt(campaign.smartlead_campaign_id), updateFields.email_sequence);
        console.log(`[update] Re-synced sequences to Smartlead campaign ${campaign.smartlead_campaign_id}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[update] Error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * GET /api/campaigns/:campaignId/senders
 * Return the senders attached to a campaign (via junction table), with capacity info.
 */
router.get('/:campaignId/senders', async (req, res) => {
  const { campaignId } = req.params;
  const admin = getSupabaseAdmin();

  const { data: rows, error } = await admin
    .from('campaign_senders')
    .select('sender_id, senders(id, email, display_name, verified, warmup_started_at, connection_type, verification_error)')
    .eq('campaign_id', campaignId);

  if (error) return res.status(500).json({ error: error.message });

  const senders = (rows ?? [])
    .map(r => r.senders)
    .filter(Boolean)
    .map(s => ({ ...s, daily_capacity: estimateCapacity(s.warmup_started_at) }));

  const totalCapacity = senders.reduce((sum, s) => sum + s.daily_capacity, 0);
  res.json({ senders, total_daily_capacity: totalCapacity });
});

/**
 * POST /api/campaigns/:campaignId/senders  { sender_id }
 * Attach a sender to a campaign; re-attach to Smartlead if already synced.
 */
router.post('/:campaignId/senders', async (req, res) => {
  const { campaignId } = req.params;
  const { sender_id } = req.body ?? {};
  if (!sender_id) return res.status(400).json({ error: 'sender_id required' });

  const admin = getSupabaseAdmin();

  const { error: insertErr } = await admin
    .from('campaign_senders')
    .upsert({ campaign_id: campaignId, sender_id }, { onConflict: 'campaign_id,sender_id' });
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  // Re-attach all senders to Smartlead if campaign is synced
  const { data: campaign } = await admin
    .from('campaigns').select('smartlead_campaign_id').eq('id', campaignId).single();
  if (campaign?.smartlead_campaign_id && campaign.smartlead_campaign_id !== 'syncing') {
    const { slEmailAccountIds } = await resolveCampaignSenders(campaignId);
    if (slEmailAccountIds.length > 0) {
      await attachEmailAccount(parseInt(campaign.smartlead_campaign_id), slEmailAccountIds);
    }
  }

  res.json({ success: true });
});

/**
 * DELETE /api/campaigns/:campaignId/senders/:senderId
 */
router.delete('/:campaignId/senders/:senderId', async (req, res) => {
  const { campaignId, senderId } = req.params;
  const admin = getSupabaseAdmin();

  const { error } = await admin
    .from('campaign_senders')
    .delete()
    .eq('campaign_id', campaignId)
    .eq('sender_id', senderId);
  if (error) return res.status(500).json({ error: error.message });

  // Re-attach remaining senders in Smartlead
  const { data: campaign } = await admin
    .from('campaigns').select('smartlead_campaign_id').eq('id', campaignId).single();
  if (campaign?.smartlead_campaign_id && campaign.smartlead_campaign_id !== 'syncing') {
    const { slEmailAccountIds } = await resolveCampaignSenders(campaignId);
    if (slEmailAccountIds.length > 0) {
      await attachEmailAccount(parseInt(campaign.smartlead_campaign_id), slEmailAccountIds);
    }
  }

  res.json({ success: true });
});

/**
 * POST /api/campaigns/find-leads
 * Manually trigger target_finder_100_leads for a campaign.
 * Body: { campaign_id, user_details_id }
 */
router.post('/find-leads', async (req, res) => {
  const { campaign_id } = req.body;
  if (!campaign_id) {
    return res.status(400).json({ error: 'campaign_id required' });
  }

  const admin = getSupabaseAdmin();
  const { data: campaign } = await admin
    .from('campaigns').select('itp_id, account_id').eq('id', campaign_id).single();

  if (!campaign?.itp_id) {
    return res.status(404).json({ error: 'Campaign not found or has no ITP' });
  }

  const { data: userDetails } = await admin
    .from('user_details').select('id').eq('account_id', campaign.account_id).limit(1).single();

  if (!userDetails) {
    return res.status(404).json({ error: 'No user found for this campaign' });
  }

  res.json({ dispatched: true, campaign_id, itp_id: campaign.itp_id });

  dispatchSkill('lead_gen_expert', 'target_finder_100_leads', {
    user_details_id: userDetails.id,
    itp_id: campaign.itp_id,
    campaign_id,
  }).catch(err => console.error('[find-leads] dispatch error:', err));
});

export default router;
