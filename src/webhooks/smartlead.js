import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';

const router = Router();

// Status mapping from Smartlead events to our campaign_contacts statuses
const EVENT_TO_STATUS = {
  'EMAIL_SENT': 'sent',
  'EMAIL_OPENED': 'opened',
  'EMAIL_REPLIED': 'replied',
  'EMAIL_BOUNCED': 'bounced',
  'EMAIL_UNSUBSCRIBED': 'unsubscribed',
};

router.post('/', async (req, res) => {
  // Respond immediately
  res.json({ received: true });

  try {
    const payload = req.body;
    const event = payload.event ?? payload.type;
    const newStatus = EVENT_TO_STATUS[event];

    if (!newStatus) {
      console.log(`[smartlead-webhook] Unknown event: ${event}`);
      return;
    }

    const leadEmail = payload.lead?.email;
    const slCampaignId = String(payload.campaign_id);

    if (!leadEmail || !slCampaignId) {
      console.log(`[smartlead-webhook] Missing lead email or campaign_id`);
      return;
    }

    console.log(`[smartlead-webhook] ${event} for ${leadEmail} in campaign ${slCampaignId}`);

    // Find our campaign by smartlead_campaign_id
    const { data: campaign } = await getSupabaseAdmin()
      .from('campaigns')
      .select('id')
      .eq('smartlead_campaign_id', slCampaignId)
      .single();

    if (!campaign) {
      console.warn(`[smartlead-webhook] No matching campaign for Smartlead ID ${slCampaignId}`);
      return;
    }

    // Find the contact by email
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

    // Update campaign_contacts status
    const updateFields = { status: newStatus };
    if (newStatus === 'sent') updateFields.sent_at = new Date().toISOString();
    if (newStatus === 'opened') updateFields.opened_at = new Date().toISOString();
    if (newStatus === 'replied') updateFields.replied_at = new Date().toISOString();

    const { error } = await getSupabaseAdmin()
      .from('campaign_contacts')
      .update(updateFields)
      .eq('campaign_id', campaign.id)
      .eq('contact_id', contact.id);

    if (error) {
      console.error(`[smartlead-webhook] Update error:`, error.message);
    } else {
      console.log(`[smartlead-webhook] Updated ${leadEmail} → ${newStatus}`);
    }
  } catch (err) {
    console.error('[smartlead-webhook] Error:', err);
  }
});

export default router;
