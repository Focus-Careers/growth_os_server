import express from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { attachEmailAccount } from '../config/smartlead.js';
import { resolveSmartleadSender } from '../employees/email_campaign_manager/helpers/resolve_smartlead_sender.js';

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
    // Update sender_id in our DB
    const { error: updateError } = await admin
      .from('campaigns')
      .update({ sender_id })
      .eq('id', campaign_id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update campaign sender', detail: updateError.message });
    }

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

export default router;
