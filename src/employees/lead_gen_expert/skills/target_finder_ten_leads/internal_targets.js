import { getSupabaseAdmin } from '../../../../config/supabase.js';

const INTERNAL_BATCH_SIZE = 20;

export async function scoreInternalTargets({
  itp,
  accountId,
  autoApprove,
  scoreThreshold,
  fillTemplate,
  structuredScoreTemplate,
  buyerContext,
  scoreStructuredBatch,
}) {
  const admin = getSupabaseAdmin();

  const { data: itpData } = await admin.from('itp').select('id').eq('account_id', accountId);
  const itpIds = (itpData ?? []).map(i => i.id);
  if (!itpIds.length) return 0;

  const { data: allLeads } = await admin.from('leads').select('target_id, itp_id').in('itp_id', itpIds);

  const alreadyEvaluated = new Set(
    (allLeads ?? []).filter(l => l.itp_id === itp.id).map(l => l.target_id)
  );
  const candidateIds = [...new Set(
    (allLeads ?? [])
      .filter(l => l.itp_id !== itp.id && !alreadyEvaluated.has(l.target_id))
      .map(l => l.target_id)
  )];
  if (!candidateIds.length) return 0;

  const { data: targets } = await admin
    .from('targets')
    .select('id, title, domain, industry, company_location, companies_house_number')
    .in('id', candidateIds);
  if (!targets?.length) return 0;

  console.log(`[internal_targets] Scoring ${targets.length} candidate targets from internal DB`);

  const companies = targets.map(t => ({
    companyName:       t.title,
    domain:            t.domain,
    sicDescription:    t.industry,
    location:          t.company_location,
    dateOfCreation:    null,
    officers:          [],
    companyNumber:     t.companies_house_number,
    _internalTargetId: t.id,
  }));

  let leadsCreated = 0;
  for (let i = 0; i < companies.length; i += INTERNAL_BATCH_SIZE) {
    const batch = companies.slice(i, i + INTERNAL_BATCH_SIZE);
    const scores = await scoreStructuredBatch(batch, fillTemplate, structuredScoreTemplate, buyerContext);
    for (const item of scores) {
      if ((item.score ?? 0) < scoreThreshold) continue;
      const target = batch[item.index];
      if (!target) continue;
      const { error } = await admin.from('leads').insert({
        target_id:    target._internalTargetId,
        itp_id:       itp.id,
        score:        item.score,
        score_reason: item.reason ?? null,
        ...(autoApprove ? { approved: true } : {}),
      });
      if (error && error.code !== '23505') {
        console.error('[internal_targets] leads insert error:', error.message);
      } else if (!error) {
        leadsCreated++;
      }
    }
  }

  console.log(`[internal_targets] Created ${leadsCreated} leads from internal DB`);
  return leadsCreated;
}
