import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { classifyReply } from '../intelligence/reply_classifier/index.js';
import { sendAppMessage } from '../intelligence/app_message_sender/index.js';

const router = Router();

const EVENT_TO_STATUS = {
  'EMAIL_SENT': 'sent',
  'EMAIL_OPENED': 'opened',
  'EMAIL_REPLIED': 'replied',
  'EMAIL_BOUNCED': 'bounced',
  'EMAIL_UNSUBSCRIBED': 'unsubscribed',
  // Smartlead per-campaign webhooks use LEAD_ prefix
  'LEAD_SENT': 'sent',
  'LEAD_OPENED': 'opened',
  'LEAD_REPLIED': 'replied',
  'LEAD_BOUNCED': 'bounced',
  'LEAD_UNSUBSCRIBED': 'unsubscribed',
  'LEAD_CLICKED': 'opened',
};

/**
 * Look up the user_details_id for a campaign (needed for broadcasts + notifications).
 */
async function getUserForCampaign(campaignId) {
  const { data: campaign } = await getSupabaseAdmin()
    .from('campaigns')
    .select('account_id')
    .eq('id', campaignId)
    .single();
  if (!campaign?.account_id) return null;

  const { data: ud } = await getSupabaseAdmin()
    .from('user_details')
    .select('id')
    .eq('account_id', campaign.account_id)
    .limit(1)
    .single();
  return ud?.id ?? null;
}

/**
 * Broadcast a contact status change to the frontend via Supabase Realtime.
 */
async function broadcastContactUpdate(userDetailsId, payload) {
  try {
    await getSupabaseAdmin()
      .channel(`campaign_updates:${userDetailsId}`)
      .send({
        type: 'broadcast',
        event: 'contact_status_change',
        payload,
      });
  } catch (err) {
    console.warn('[smartlead-webhook] Broadcast error:', err.message);
  }
}

router.post('/', async (req, res) => {
  // Respond immediately so Smartlead doesn't retry
  res.json({ received: true });

  try {
    const payload = req.body;
    const event = payload.event_type ?? payload.event ?? payload.type;
    const leadEmail = payload.lead?.email;
    const slCampaignId = String(payload.campaign_id);

    if (!leadEmail || !slCampaignId) {
      console.log(`[smartlead-webhook] Missing lead email or campaign_id`);
      return;
    }

    console.log(`[smartlead-webhook] ${event} for ${leadEmail} in campaign ${slCampaignId}`);

    // Find our campaign
    const { data: campaign } = await getSupabaseAdmin()
      .from('campaigns')
      .select('id, name')
      .eq('smartlead_campaign_id', slCampaignId)
      .single();

    if (!campaign) {
      console.warn(`[smartlead-webhook] No matching campaign for Smartlead ID ${slCampaignId}`);
      return;
    }

    // Find the contact
    const { data: contact } = await getSupabaseAdmin()
      .from('contacts')
      .select('id')
      .eq('email', leadEmail.toLowerCase())
      .limit(1)
      .single();

    if (!contact) {
      console.warn(`[smartlead-webhook] No matching contact for ${leadEmail}`);
      return;
    }

    // Handle LEAD_CATEGORY_UPDATED separately (no status change)
    if (event === 'LEAD_CATEGORY_UPDATED') {
      const category = payload.category ?? payload.lead_category ?? null;
      if (category) {
        await getSupabaseAdmin()
          .from('campaign_contacts')
          .update({ smartlead_category: category })
          .eq('campaign_id', campaign.id)
          .eq('contact_id', contact.id);
        console.log(`[smartlead-webhook] Updated Smartlead category → ${category} for ${leadEmail}`);
      }
      return;
    }

    // Map event to our status
    const newStatus = EVENT_TO_STATUS[event];
    if (!newStatus) {
      console.log(`[smartlead-webhook] Unknown event: ${event}`);
      return;
    }

    // Build update fields
    const updateFields = { status: newStatus };
    if (newStatus === 'sent') updateFields.sent_at = payload.timestamp ?? new Date().toISOString();
    if (newStatus === 'opened') updateFields.opened_at = payload.timestamp ?? new Date().toISOString();
    if (newStatus === 'replied') {
      updateFields.replied_at = payload.timestamp ?? new Date().toISOString();
      if (payload.reply_body) updateFields.reply_body = payload.reply_body;
    }

    // Update DB
    const { error } = await getSupabaseAdmin()
      .from('campaign_contacts')
      .update(updateFields)
      .eq('campaign_id', campaign.id)
      .eq('contact_id', contact.id);

    if (error) {
      console.error(`[smartlead-webhook] Update error:`, error.message);
      return;
    }

    console.log(`[smartlead-webhook] Updated ${leadEmail} → ${newStatus}`);

    // Classify replies
    let classification = null;
    if (newStatus === 'replied' && payload.reply_body) {
      classification = await classifyReply(payload.reply_body);
      await getSupabaseAdmin()
        .from('campaign_contacts')
        .update({ classification })
        .eq('campaign_id', campaign.id)
        .eq('contact_id', contact.id);
      console.log(`[smartlead-webhook] Classified reply from ${leadEmail} → ${classification}`);
    }

    // Broadcast to frontend
    const userDetailsId = await getUserForCampaign(campaign.id);
    if (userDetailsId) {
      const leadName = `${payload.lead?.first_name ?? ''} ${payload.lead?.last_name ?? ''}`.trim();

      await broadcastContactUpdate(userDetailsId, {
        campaign_id: campaign.id,
        contact_id: contact.id,
        status: newStatus,
        reply_body: payload.reply_body ?? null,
        classification,
        lead_email: leadEmail,
        lead_name: leadName,
      });

      // Notify Watson for positive replies only
      if (classification === 'positive') {
        await sendAppMessage({
          type: 'webhook_notification',
          employee: 'email_campaign_manager',
          skill: 'reply_received',
          user_details_id: userDetailsId,
          navigate_to: 'Draper',
          output: {
            lead_name: leadName,
            lead_email: leadEmail,
            company: payload.lead?.company_name ?? '',
            campaign_name: campaign.name,
            reply_body: payload.reply_body,
            classification,
          },
        });
      }
    }
  } catch (err) {
    console.error('[smartlead-webhook] Error:', err);
  }
});

export default router;
