// -------------------------------------------------------------------------
// PUSH LEAD CONTACTS TO CAMPAIGN
// Triggered when a lead is approved (manually via the approve endpoint, or
// auto-approved at 100_leads persist time and rediscovered). Looks up the
// lead's target's contacts from the per-account contacts pool and hands them
// to addContactsToCampaign — which applies the approval gate, in-campaign
// dedup, cross-campaign dedup, the campaign_contacts insert, and the
// Smartlead push.
//
// Idempotent: returns silently if the lead isn't approved, has no contacts,
// or has no associated campaign yet.
// -------------------------------------------------------------------------

import { getSupabaseAdmin } from '../../config/supabase.js';
import { addContactsToCampaign } from '../../employees/lead_gen_expert/skills/target_finder_100_leads/index.js';

export async function pushApprovedLeadToCampaign(lead_id) {
  if (!lead_id) return;
  const admin = getSupabaseAdmin();

  // Load the lead and confirm it's approved before doing any work.
  const { data: lead } = await admin
    .from('leads')
    .select('id, target_id, itp_id, approved')
    .eq('id', lead_id)
    .single();
  if (!lead) {
    console.warn(`[push_lead_contacts] lead ${lead_id} not found`);
    return;
  }
  if (!lead.approved) {
    console.log(`[push_lead_contacts] lead ${lead_id} is not approved — skipping push`);
    return;
  }
  if (!lead.target_id || !lead.itp_id) {
    console.warn(`[push_lead_contacts] lead ${lead_id} missing target_id/itp_id`);
    return;
  }

  // Find the campaign for this ITP. Prefer an active one; fall back to the
  // most-recent campaign tied to the ITP if none are active yet (e.g. still
  // in setup). If no campaign exists at all, the contacts stay in the pool
  // and a future run / campaign creation will pick them up.
  const { data: campaigns } = await admin
    .from('campaigns')
    .select('id, account_id, status, created_at')
    .eq('itp_id', lead.itp_id)
    .order('created_at', { ascending: false });

  if (!campaigns?.length) {
    console.log(`[push_lead_contacts] no campaign for ITP ${lead.itp_id} — lead ${lead_id} contacts stay in pool`);
    return;
  }

  const targetCampaign = campaigns.find(c => c.status === 'active') ?? campaigns[0];
  const account_id = targetCampaign.account_id;

  // Load this target's contacts from the account's pool. Include contacts
  // without emails too — the downstream Smartlead push filters those itself.
  const { data: contacts } = await admin
    .from('contacts')
    .select('id, target_id')
    .eq('target_id', lead.target_id)
    .eq('account_id', account_id);

  if (!contacts?.length) {
    console.log(`[push_lead_contacts] no contacts for target ${lead.target_id} on account ${account_id} — lead ${lead_id} approved but nothing to push yet`);
    return;
  }

  await addContactsToCampaign(targetCampaign.id, { contacts }, null);
  console.log(`[push_lead_contacts] pushed ${contacts.length} contact(s) for lead ${lead_id} → campaign ${targetCampaign.id}`);
}
