/**
 * target_finder_ten_leads — v2 (sanity-check sized)
 *
 * Pre-flight sanity check before the production run (target_finder_100_leads).
 * Goal: surface ~10–15 reasonable candidates fast so the user can verify the
 * ITP is searching for the right things. NOT a full lead-gen run.
 *
 * Pipeline (per round):
 *   generateQueryProfile (calibration mode) → runSearchQueries
 *   → scrapeSite (parallel) → classifyLivenessBatch → scoreCandidatesBatch
 *
 * Rounds loop until the qualified pool ≥ TARGET_MIN or MAX_ROUNDS hits.
 * Each new round reads prior_search_queries from the DB so the LLM naturally
 * widens away from queries already used.
 *
 * Selection:
 *   - Sort by score desc
 *   - Take all tier A/B (capped at RETURN_CAP)
 *   - If < TARGET_MIN, top up with tier C in score order
 *
 * Deliberately NOT done here: directory fan-out, CH match, Apollo enrichment,
 * contact extraction. Those belong to target_finder_100_leads.
 */

import { generateQueryProfile } from '../../../../lib/lead_gen/query_generator.js';
import { runSearchQueries } from '../../../../lib/lead_gen/search_runner.js';
import { scrapeSite } from '../../../../lib/lead_gen/scraper.js';
import { classifyLivenessBatch, CLASSIFICATION } from '../../../../lib/lead_gen/liveness_classifier.js';
import { scoreCandidatesBatch, TIER } from '../../../../lib/lead_gen/itp_scorer.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';
import { openRun, increment, closeRun } from '../../../../lib/cost_tracker.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

// Calibration sizing — small per round, multiple rounds if we need to reach the min.
const RESULTS_PER_QUERY = 3;
const MAX_SEARCH_RESULTS = 18;
const MAX_SCRAPE_CONCURRENCY = 10;
const TARGET_MIN = 10;     // hard minimum we try to return (best-effort within MAX_ROUNDS)
const RETURN_CAP = 15;     // never return more than this
const MAX_ROUNDS = 3;      // safety cap to avoid runaway cost on niche ITPs

// ─── Main skill entry point ───────────────────────────────────────────────────

export async function executeSkill({ user_details_id, itp_id }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();
  if (!userDetails) throw new Error('target_finder_ten_leads: user_details not found');

  let itpQuery = admin.from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();
  if (!itp) throw new Error('target_finder_ten_leads: no ITP found for account');

  const { data: account } = await admin
    .from('account').select('*').eq('id', itp.account_id).single();

  const runId = await openRun({
    account_id: userDetails.account_id,
    itp_id: itp.id,
    user_details_id,
  });

  console.log(`[ten_leads] Starting for ITP ${itp.id} (${itp.name ?? 'unnamed'})`);

  try {
    // Load confirmed positives once (few-shot context for scoring).
    const confirmedPositives = await loadConfirmedPositives(admin, itp.id);

    // Account-level dedup (existing targets + customers). Mutated as
    // runSearchQueries adds the domains it returns, so each subsequent round
    // automatically skips anything we've already surfaced this run.
    const seenDomains = await buildDedupSet(admin, userDetails.account_id);

    // Accumulated across rounds.
    const scoredPool = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const tag = `Round ${round}:`;

      // ── Step 1: Query profile (calibration mode → fewer, broader queries) ──
      await progress(user_details_id, `${tag} Building search profile…`, pctFor(round, 0));
      const queryProfile = await generateQueryProfile({ itp, account, mode: 'calibration' });
      const directoryWhitelist = queryProfile.directory_whitelist ?? [];

      // ── Step 2: Search ─────────────────────────────────────────────────────
      await progress(user_details_id, `${tag} Searching for candidates…`, pctFor(round, 0.15));
      const { results, serper_calls, queries_used } = await runSearchQueries({
        queries:           queryProfile.search_queries ?? [],
        results_per_query: RESULTS_PER_QUERY,
        location:          itp.location,
        max_results:       MAX_SEARCH_RESULTS,
        seen_domains:      seenDomains,
      });
      await increment(runId, { serper_calls_used: serper_calls });
      console.log(`[ten_leads] ${tag} ${results.length} search results after dedup`);

      // Persist used queries so future runs (this and 100_leads) avoid them.
      if (queries_used?.length) {
        await admin.from('target_finder_google_search_prompts').insert(
          queries_used.map(query => ({ itp: itp.id, query }))
        );
      }

      if (results.length === 0) {
        console.log(`[ten_leads] ${tag} no new results — moving to next round if available`);
        continue;
      }

      // ── Step 3: Scrape (parallel) ──────────────────────────────────────────
      await progress(user_details_id, `${tag} Scraping ${results.length} pages…`, pctFor(round, 0.30));
      const scraped = await runParallel(
        results,
        r => scrapeSite({ domain: r.domain, page_set: 'homepage_plus_about_contact' })
            .then(s => ({ result: r, scraped: s })),
        MAX_SCRAPE_CONCURRENCY
      );

      // ── Step 4: Classify (batched — 8 per LLM call, no fan-out) ────────────
      await progress(user_details_id, `${tag} Analysing pages…`, pctFor(round, 0.50));
      const classificationResults = await classifyLivenessBatch(
        scraped.map(({ result, scraped: s }) => ({ url: result.url, scraped: s })),
        directoryWhitelist
      );
      await increment(runId, { haiku_calls_used: Math.ceil(scraped.length / 8) });

      // Keep REAL_OPERATING_BUSINESS only — directories are intentionally dropped
      // (fan-out is target_finder_100_leads' job, not the sanity-check's).
      const newCandidates = [];
      for (let i = 0; i < scraped.length; i++) {
        const cls = classificationResults[i]?.classification;
        if (cls !== CLASSIFICATION.REAL_OPERATING_BUSINESS) continue;
        const { result, scraped: s } = scraped[i];
        newCandidates.push({
          url:              result.url,
          domain:           result.domain,
          title:            result.title,
          scraped:          s,
          classification:   classificationResults[i],
          discovery_source: 'serper_direct',
        });
      }

      console.log(`[ten_leads] ${tag} ${newCandidates.length} real businesses after classification`);
      if (newCandidates.length === 0) continue;

      // ── Step 5: Score (batched — single LLM call for ≤18 candidates) ───────
      await progress(user_details_id, `${tag} Scoring ${newCandidates.length} candidates…`, pctFor(round, 0.75));
      const scoreInputs = newCandidates.map(c => ({
        company_name:        c.title ?? c.domain ?? 'Unknown',
        domain:              c.domain ?? null,
        company_description: c.scraped?.all_text?.slice(0, 600) ?? null,
      }));

      let scoreResults;
      try {
        scoreResults = await scoreCandidatesBatch({
          itp,
          account,
          candidates:          scoreInputs,
          confirmed_positives: confirmedPositives,
        });
        await increment(runId, { haiku_calls_used: 1 });
      } catch (err) {
        console.error(`[ten_leads] ${tag} scoreCandidatesBatch error:`, err.message);
        continue;
      }

      for (let i = 0; i < newCandidates.length; i++) {
        const r = scoreResults[i] ?? { score: 0, tier: TIER.REJECT, reasoning: 'No score returned.' };
        scoredPool.push({ ...newCandidates[i], score: r.score, tier: r.tier, reasoning: r.reasoning });
      }

      // ── Check: do we have enough qualified candidates yet? ─────────────────
      const qualified = selectQualified(scoredPool);
      console.log(`[ten_leads] ${tag} pool ${scoredPool.length} scored → ${qualified.length} qualified (need ≥ ${TARGET_MIN})`);
      if (qualified.length >= TARGET_MIN) break;
    }

    // ── Final selection & persistence ─────────────────────────────────────────
    const final = selectQualified(scoredPool);
    console.log(`[ten_leads] Final: ${final.length} candidates (from ${scoredPool.length} scored)`);

    await progress(user_details_id, 'Saving results…', 92);
    const savedLeads = [];
    for (const candidate of final) {
      const lead = await persistCandidate(admin, candidate, itp, userDetails.account_id);
      if (lead) savedLeads.push(lead);
    }

    await closeRun(runId, 'completed');
    return finalize({ itp, user_details_id, savedLeads, runId });

  } catch (err) {
    console.error('[ten_leads] Fatal error:', err.message);
    await closeRun(runId, 'failed', err.message);
    throw err;
  }
}

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Returns up to RETURN_CAP candidates, prioritising tier A/B by score and
 * topping up with tier C only if the A/B count is below TARGET_MIN.
 */
function selectQualified(scoredPool) {
  const sorted = [...scoredPool].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const ab = sorted.filter(c => c.tier === TIER.A || c.tier === TIER.B).slice(0, RETURN_CAP);
  if (ab.length >= TARGET_MIN) return ab;
  const need = Math.min(TARGET_MIN - ab.length, RETURN_CAP - ab.length);
  const cFillers = sorted.filter(c => c.tier === TIER.C).slice(0, need);
  return [...ab, ...cFillers];
}

// ─── Progress ────────────────────────────────────────────────────────────────

/** Spread progress evenly across rounds: round 1 → 5–33%, round 2 → 35–63%, round 3 → 65–93%. */
function pctFor(round, fraction) {
  return Math.min(95, Math.round(5 + (round - 1) * 30 + fraction * 28));
}

async function progress(user_details_id, message, percent) {
  await broadcastSkillStatus(user_details_id, {
    employee: 'lead_gen_expert',
    skill: 'target_finder_ten_leads',
    status: 'running',
    message: `${message} ${percent}%`,
    persist: false,
  });
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function runParallel(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ─── Dedup ───────────────────────────────────────────────────────────────────

/**
 * Build a set of all domains already seen on this account (existing targets +
 * customer list). Prevents re-surfacing companies we already have. Mutated
 * across rounds by runSearchQueries.
 */
async function buildDedupSet(admin, accountId) {
  const { data: itpRows } = await admin
    .from('itp').select('id').eq('account_id', accountId);
  const itpIds = (itpRows ?? []).map(r => r.id);

  const domains = new Set();

  if (itpIds.length) {
    const { data: leadRows } = await admin
      .from('leads').select('target_id').in('itp_id', itpIds);
    const targetIds = [...new Set((leadRows ?? []).map(l => l.target_id).filter(Boolean))];
    if (targetIds.length) {
      const { data: targetRows } = await admin
        .from('targets').select('domain').in('id', targetIds);
      (targetRows ?? []).forEach(t => t.domain && domains.add(t.domain));
    }
  }

  const { data: custRows } = await admin
    .from('customers').select('organisation_website').eq('account_id', accountId);
  (custRows ?? []).forEach(c => {
    if (c.organisation_website) {
      try {
        const d = new URL(c.organisation_website).hostname.replace(/^www\./, '');
        domains.add(d.toLowerCase());
      } catch { /* ignore */ }
    }
  });

  return domains;
}

// ─── Confirmed positives for few-shot scoring ────────────────────────────────

async function loadConfirmedPositives(admin, itpId) {
  const { data } = await admin
    .from('leads')
    .select('score_reason, targets(title, domain)')
    .eq('itp_id', itpId)
    .eq('confirmed_positive', true)
    .order('score', { ascending: false })
    .limit(5);
  return (data ?? []).map(l => ({
    title: l.targets?.title ?? l.targets?.domain ?? 'Unknown',
    domain: l.targets?.domain ?? null,
    score_reason: l.score_reason ?? null,
  }));
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persistCandidate(admin, candidate, itp, accountId) {
  const domain = candidate.domain ?? null;
  const metadata = candidate.classification?.extracted_metadata ?? {};
  const location = metadata.postcodes?.[0] ?? null;

  const { data: target, error: targetErr } = await admin
    .from('targets')
    .insert({
      domain,
      title: candidate.title ?? domain ?? 'Unknown',
      link: domain ? `https://${domain}` : (candidate.url ?? null),
      company_location: location,
    })
    .select('id')
    .single();

  if (targetErr) {
    console.error(`[ten_leads] Target insert error for ${domain}:`, targetErr.message);
    return null;
  }

  const { data: lead, error: leadErr } = await admin
    .from('leads')
    .insert({
      target_id:        target.id,
      itp_id:           itp.id,
      score:            candidate.score,
      score_reason:     candidate.reasoning ?? null,
      discovery_source: candidate.discovery_source ?? 'serper_direct',
      // approved / confirmed_positive left null — user sets in approval sidebar
    })
    .select('id')
    .single();

  if (leadErr) {
    console.error(`[ten_leads] Lead insert error for ${domain}:`, leadErr.message);
    return null;
  }

  console.log(`[ten_leads] Saved: ${candidate.title ?? domain} (score: ${candidate.score}, tier: ${candidate.tier})`);
  return lead;
}

// ─── Finalize ────────────────────────────────────────────────────────────────

async function finalize({ itp, user_details_id, savedLeads, runId }) {
  await progress(user_details_id, 'Done!', 100);

  const highScoreCount = savedLeads.length;
  console.log(`[ten_leads] Finished: ${highScoreCount} candidates saved for review`);

  await processSkillOutput({
    employee:   'lead_gen_expert',
    skill_name: 'target_finder_ten_leads',
    user_details_id,
    output: {
      itp_id:            itp.id,
      high_score_count:  highScoreCount,
      total_targets:     highScoreCount,
    },
  });

  return { user_details_id, itp_id: itp.id, leads: savedLeads };
}
