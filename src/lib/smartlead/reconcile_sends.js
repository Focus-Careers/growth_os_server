import { getSupabaseAdmin } from '../../config/supabase.js';
import { getCampaignStatistics } from '../../config/smartlead.js';

// Mirrors the rank logic in webhooks/smartlead.js — never regress a contact's status.
const STATUS_RANK = { sent: 1, opened: 2, replied: 3 };

/**
 * Reconcile a campaign's send history from the Smartlead statistics API.
 *
 * Smartlead does not fire EMAIL_SENT webhooks for follow-up sequence sends, so the
 * statistics endpoint (one row per individual send, including follow-ups) is the only
 * complete source of truth for what was actually sent. This pulls all rows and:
 *   - inserts a 'sent' event per (contact, sequence_number) it doesn't already have
 *   - advances each contact's current_sequence and bumps status to >= 'sent'
 *
 * Engagement timestamps (opened_at / replied_at / classification) are left untouched —
 * those remain webhook-sourced, since the stats endpoint only gives a sent_time + flags.
 *
 * @param {string} campaignId - our internal campaign UUID
 * @returns {Promise<object>} summary of what changed
 */
export async function reconcileCampaignSends(campaignId) {
  const supabase = getSupabaseAdmin();

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, smartlead_campaign_id')
    .eq('id', campaignId)
    .single();

  if (!campaign?.smartlead_campaign_id) {
    return { campaign_id: campaignId, skipped: 'no smartlead_campaign_id' };
  }

  const records = await getCampaignStatistics(campaign.smartlead_campaign_id);
  if (!records.length) {
    return { campaign_id: campaignId, stats_rows: 0, inserted: 0, contacts_updated: 0 };
  }

  // Map lead emails → our contact ids (one query for all emails in the campaign)
  const emails = [...new Set(
    records.map(r => (r.lead_email ?? '').toLowerCase()).filter(Boolean)
  )];
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, email')
    .in('email', emails);
  const contactByEmail = new Map((contacts ?? []).map(c => [c.email.toLowerCase(), c.id]));

  // Existing 'sent' events so we only insert the ones we're missing (idempotent re-runs)
  const { data: existing } = await supabase
    .from('campaign_contact_events')
    .select('contact_id, sequence_number')
    .eq('campaign_id', campaignId)
    .eq('event_type', 'sent');
  const seen = new Set((existing ?? []).map(e => `${e.contact_id}:${e.sequence_number}`));

  const toInsert = [];
  const maxSeqByContact = new Map();   // contact_id -> highest sequence seen
  const repliedContacts = new Set();   // contacts with at least one replied send

  for (const r of records) {
    const email = (r.lead_email ?? '').toLowerCase();
    const contactId = contactByEmail.get(email);
    if (!contactId) continue;

    const seq = Number(r.sequence_number) || null;
    if (seq == null) continue; // can't dedup or place a send without a sequence number

    const key = `${contactId}:${seq}`;
    if (!seen.has(key)) {
      seen.add(key);
      toInsert.push({
        campaign_id: campaignId,
        contact_id: contactId,
        event_type: 'sent',
        sequence_number: seq,
        event_at: r.sent_time ?? r.sent_at ?? null,
      });
    }

    const prevMax = maxSeqByContact.get(contactId) ?? 0;
    if (seq > prevMax) maxSeqByContact.set(contactId, seq);
    if (r.is_replied) repliedContacts.add(contactId);
  }

  // Insert missing send events
  let inserted = 0;
  if (toInsert.length) {
    const { error } = await supabase.from('campaign_contact_events').insert(toInsert);
    if (error && error.code !== '23505') {
      console.error(`[reconcile] event insert error for ${campaignId}:`, error.message);
    } else {
      inserted = toInsert.length;
    }
  }

  // Advance current_sequence + status per contact (no regression)
  const contactIds = [...maxSeqByContact.keys()];
  let contactsUpdated = 0;
  if (contactIds.length) {
    const { data: ccRows } = await supabase
      .from('campaign_contacts')
      .select('contact_id, status, current_sequence')
      .eq('campaign_id', campaignId)
      .in('contact_id', contactIds);
    const ccByContact = new Map((ccRows ?? []).map(cc => [cc.contact_id, cc]));

    for (const contactId of contactIds) {
      const cc = ccByContact.get(contactId);
      if (!cc) continue; // contact isn't in this campaign — skip

      const maxSeq = maxSeqByContact.get(contactId);
      const update = {};

      if (maxSeq > (cc.current_sequence ?? 0)) update.current_sequence = maxSeq;

      // Bump status to at least 'sent' — but never overwrite a more advanced state.
      // (We don't promote to 'replied' here; replies are owned by the webhook so the
      // reply_body/classification stay consistent.)
      const currentRank = STATUS_RANK[cc.status] ?? 0;
      if (currentRank < STATUS_RANK.sent) update.status = 'sent';

      if (Object.keys(update).length) {
        const { error } = await supabase
          .from('campaign_contacts')
          .update(update)
          .eq('campaign_id', campaignId)
          .eq('contact_id', contactId);
        if (!error) contactsUpdated++;
      }
    }
  }

  const summary = {
    campaign_id: campaignId,
    stats_rows: records.length,
    inserted,
    contacts_updated: contactsUpdated,
  };
  console.log(`[reconcile] ${JSON.stringify(summary)}`);
  return summary;
}
