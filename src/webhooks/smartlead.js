import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { classifyReply } from '../intelligence/reply_classifier/index.js';
import { sendAppMessage } from '../intelligence/app_message_sender/index.js';

const router = Router();

// Status rank: higher number = more advanced state; never regress to a lower status.
// Exception: bounced/unsubscribed always override (terminal states from Smartlead).
const STATUS_RANK = { sent: 1, opened: 2, replied: 3 };
const TERMINAL_STATUSES = new Set(['bounced', 'unsubscribed', 'failed']);

// Smartlead uses inconsistent event names across API versions — handle all variants
const EVENT_TO_STATUS = {
  'EMAIL_SENT': 'sent',
  'FIRST_EMAIL_SENT': 'sent',
  'EMAIL_OPEN': 'opened',
  'EMAIL_OPENED': 'opened',
  'EMAIL_REPLY': 'replied',
  'EMAIL_REPLIED': 'replied',
  'REPLY_RECEIVED': 'replied',
  'EMAIL_BOUNCE': 'bounced',
  'EMAIL_BOUNCED': 'bounced',
  'EMAIL_UNSUBSCRIBED': 'unsubscribed',
  'LEAD_SENT': 'sent',
  'LEAD_OPENED': 'opened',
  'LEAD_REPLIED': 'replied',
  'LEAD_BOUNCED': 'bounced',
  'LEAD_UNSUBSCRIBED': 'unsubscribed',
  'EMAIL_LINK_CLICK': 'opened',
  'EMAIL_CLICKED': 'opened',
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
    // Smartlead sends lead email as to_email at the top level, but older/alternate
    // formats nest it under lead.email or use lead_email directly
    const leadEmail = payload.to_email ?? payload.lead?.email ?? payload.lead_email;
    const slCampaignId = payload.campaign_id ? String(payload.campaign_id) : null;
    // Reply body can come in multiple formats
    const replyBody = payload.reply_body ?? payload.reply?.body ?? payload.message ?? null;
    // Category can come in multiple formats
    const category = payload.new_category ?? payload.reply_category ?? payload.category ?? null;
    // Sequence number — Smartlead has used several field names across API versions
    const sequenceNumber = payload.sequence_number ?? payload.seq_number ?? payload.email_number ?? payload.step_number ?? null;

    if (!leadEmail || !slCampaignId) {
      console.log(`[smartlead-webhook] Missing lead email or campaign_id — raw payload:`, JSON.stringify(payload, null, 2));
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

    // Smartlead uses event-specific timestamp fields, not a generic 'timestamp'
    const eventTime = payload.time_sent ?? payload.time_opened ?? payload.time_replied
      ?? payload.timestamp ?? new Date().toISOString();

    // Log every individual email event so we can count total sends across sequences
    await getSupabaseAdmin()
      .from('campaign_contact_events')
      .insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        event_type: newStatus,
        sequence_number: sequenceNumber ?? null,
        event_at: eventTime,
      });

    // Fetch current status to prevent regression (e.g. don't overwrite 'opened' with 'sent'
    // when a follow-up sequence email is sent to a lead who already opened the first).
    const { data: current } = await getSupabaseAdmin()
      .from('campaign_contacts')
      .select('status, sent_at, current_sequence')
      .eq('campaign_id', campaign.id)
      .eq('contact_id', contact.id)
      .single();

    const currentRank = STATUS_RANK[current?.status] ?? 0;
    const newRank = STATUS_RANK[newStatus] ?? 0;
    const isTerminal = TERMINAL_STATUSES.has(newStatus);

    // Build update fields
    const updateFields = {};

    // Only update status if it's a promotion, or a terminal state (bounced/unsubscribed)
    if (isTerminal || newRank >= currentRank) {
      updateFields.status = newStatus;
    }

    if (newStatus === 'sent') {
      // Only set sent_at on the very first send; subsequent sequences preserve the original
      if (!current?.sent_at) updateFields.sent_at = eventTime;
    }
    // Update current_sequence on any event where sequence is advancing — Smartlead only
    // fires EMAIL_SENT for the first email; follow-up sends show up via open/reply events
    if (sequenceNumber != null && sequenceNumber > (current?.current_sequence ?? 0)) {
      updateFields.current_sequence = sequenceNumber;
    }
    if (newStatus === 'opened') updateFields.opened_at = eventTime;
    if (newStatus === 'replied') {
      updateFields.replied_at = eventTime;
      if (replyBody) updateFields.reply_body = replyBody;
    }

    // Only hit the DB if there's something to update
    if (Object.keys(updateFields).length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('campaign_contacts')
        .update(updateFields)
        .eq('campaign_id', campaign.id)
        .eq('contact_id', contact.id);

      if (error) {
        console.error(`[smartlead-webhook] Update error:`, error.message);
        return;
      }
    }

    console.log(`[smartlead-webhook] Updated ${leadEmail} → ${newStatus} (seq ${sequenceNumber ?? '?'}, was ${current?.status ?? 'null'})`);

    // Classify replies
    let classification = null;
    if (newStatus === 'replied' && replyBody) {
      classification = await classifyReply(replyBody);
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
      const leadName = payload.to_name ?? `${payload.lead?.first_name ?? ''} ${payload.lead?.last_name ?? ''}`.trim();

      await broadcastContactUpdate(userDetailsId, {
        campaign_id: campaign.id,
        contact_id: contact.id,
        status: newStatus,
        reply_body: replyBody ?? null,
        classification,
        lead_email: leadEmail,
        lead_name: leadName,
        current_sequence: sequenceNumber ?? null,
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
            reply_body: replyBody,
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
