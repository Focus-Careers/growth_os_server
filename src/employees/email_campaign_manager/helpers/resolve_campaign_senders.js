import { getSupabaseAdmin } from '../../../config/supabase.js';
import { resolveSmartleadSender } from './resolve_smartlead_sender.js';

/**
 * Resolve all senders attached to a campaign via the campaign_senders junction table.
 * Falls back to the legacy `campaigns.sender_id` field if the junction is empty (back-compat).
 *
 * @returns {Promise<{
 *   senders: Array<{ sender_id: string, slEmailAccountId: string|null, sender: object, error?: string }>,
 *   slEmailAccountIds: number[]
 * }>}
 */
export async function resolveCampaignSenders(campaignId) {
  const admin = getSupabaseAdmin();

  const { data: junctionRows } = await admin
    .from('campaign_senders')
    .select('sender_id')
    .eq('campaign_id', campaignId);

  let senderIds = (junctionRows ?? []).map(r => r.sender_id);

  if (senderIds.length === 0) {
    const { data: campaign } = await admin
      .from('campaigns').select('sender_id').eq('id', campaignId).single();
    if (campaign?.sender_id) senderIds = [campaign.sender_id];
  }

  const resolved = [];
  const slEmailAccountIds = [];

  for (const sid of senderIds) {
    const { slEmailAccountId, sender } = await resolveSmartleadSender(sid);
    const entry = { sender_id: sid, slEmailAccountId, sender };
    if (!slEmailAccountId) {
      entry.error = sender?.verification_error ?? 'Could not connect email account to Smartlead';
    } else {
      slEmailAccountIds.push(parseInt(slEmailAccountId));
    }
    resolved.push(entry);
  }

  return { senders: resolved, slEmailAccountIds };
}
