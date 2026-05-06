import { getSupabaseAdmin } from '../config/supabase.js';

export async function filterContactsInActiveCampaigns({
  accountId,
  currentCampaignId,
  candidateContactIds,
}) {
  if (!candidateContactIds?.length) return [];
  const admin = getSupabaseAdmin();

  const { data: activeCampaigns } = await admin
    .from('campaigns').select('id')
    .eq('account_id', accountId).eq('status', 'active').neq('id', currentCampaignId);

  const activeCampaignIds = (activeCampaigns ?? []).map(c => c.id);
  if (!activeCampaignIds.length) return candidateContactIds;

  const { data: blocked } = await admin
    .from('campaign_contacts').select('contact_id')
    .in('campaign_id', activeCampaignIds).in('contact_id', candidateContactIds);

  const blockedSet = new Set((blocked ?? []).map(r => r.contact_id));
  const filtered = candidateContactIds.filter(id => !blockedSet.has(id));
  const blockedCount = candidateContactIds.length - filtered.length;
  if (blockedCount > 0) {
    console.log(`[campaign_contacts] Filtered out ${blockedCount} contacts already in active campaigns`);
  }
  return filtered;
}
