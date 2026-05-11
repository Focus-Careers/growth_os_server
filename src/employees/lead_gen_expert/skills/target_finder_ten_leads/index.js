/**
 * target_finder_ten_leads — Phase 2 rewrite
 *
 * Calibration orchestrator. Finds ~10 high-quality candidates for the user to
 * approve/reject to calibrate the ITP. Optimised for speed and breadth, not depth.
 *
 * Pipeline:
 *   generateQueryProfile → runSearchQueries → scrapeSite (parallel) →
 *   classifyLiveness (parallel) → directoryFanout (one level) →
 *   scoreCandidate (parallel) → save tier A/B → approval sidebar
 *
 * No CH matching, no contact extraction, no Apollo at this stage.
 * Those are deferred to target_finder_100_leads after calibration.
 */

import { generateQueryProfile } from '../../../../lib/lead_gen/query_generator.js';
import { runSearchQueries } from '../../../../lib/lead_gen/search_runner.js';
import { scrapeSite } from '../../../../lib/lead_gen/scraper.js';
import { classifyLiveness, CLASSIFICATION } from '../../../../lib/lead_gen/liveness_classifier.js';
import { extractDirectoryListings } from '../../../../lib/lead_gen/directory_fanout.js';
import { scoreCandidate, TIER } from '../../../../lib/lead_gen/itp_scorer.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';
import { openRun, increment, closeRun } from '../../../../lib/cost_tracker.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

// Calibration caps — conservative, speed over breadth
const RESULTS_PER_QUERY = 5;
const MAX_SEARCH_RESULTS = 50;
const MAX_SCRAPE_CONCURRENCY = 10;
const MAX_CLASSIFY_CONCURRENCY = 8;
const MAX_SCORE_CONCURRENCY = 8;
const MAX_FANOUT_LISTINGS = 20; // max listings to follow per directory page
const TARGET_CANDIDATES = 10;

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
    // ── Step 1: Query profile ───────────────────────────────────────────
    await progress(user_details_id, 'Building search profile…', 5);
    const queryProfile = await generateQueryProfile({ itp, account });
    const directoryWhitelist = queryProfile.directory_whitelist ?? [];

    // ── Step 2: Account-level dedup ─────────────────────────────────────
    const seenDomains = await buildDedupSet(admin, userDetails.account_id);

    // ── Step 3: Search ──────────────────────────────────────────────────
    await progress(user_details_id, 'Searching for candidates…', 10);
    const { results, serper_calls } = await runSearchQueries({
      queries: queryProfile.search_queries ?? [],
      results_per_query: RESULTS_PER_QUERY,
      location: itp.location,
      max_results: MAX_SEARCH_RESULTS,
      seen_domains: seenDomains,
    });
    await increment(runId, { serper_calls_used: serper_calls });
    console.log(`[ten_leads] ${results.length} search results after dedup`);

    if (results.length === 0) {
      await closeRun(runId, 'completed');
      return finalize({ itp, user_details_id, savedLeads: [], runId });
    }

    // ── Step 4: Scrape in parallel ──────────────────────────────────────
    await progress(user_details_id, `Scraping ${results.length} pages…`, 20);
    const scraped = await runParallel(
      results,
      r => scrapeSite({ domain: r.domain, page_set: 'homepage_plus_about_contact' })
          .then(s => ({ result: r, scraped: s })),
      MAX_SCRAPE_CONCURRENCY
    );

    // ── Step 5: Classify in parallel ────────────────────────────────────
    await progress(user_details_id, 'Analysing pages…', 38);
    const classified = await runParallel(
      scraped,
      ({ result, scraped: s }) =>
        classifyLiveness({ url: result.url, scraped: s, directory_whitelist: directoryWhitelist })
          .then(c => ({ result, scraped: s, classification: c })),
      MAX_CLASSIFY_CONCURRENCY
    );
    await increment(runId, { haiku_calls_used: classified.length });

    // ── Step 6: Directory fan-out (one level, no recursion) ─────────────
    await progress(user_details_id, 'Following directory listings…', 52);
    const candidatePool = []; // final pool of real businesses to score

    const fanoutTasks = [];
    for (const item of classified) {
      const cls = item.classification.classification;

      if (cls === CLASSIFICATION.REAL_OPERATING_BUSINESS) {
        candidatePool.push({
          url: item.result.url,
          domain: item.result.domain,
          title: item.result.title,
          scraped: item.scraped,
          classification: item.classification,
          discovery_source: 'serper_direct',
          directory_only: false,
        });

      } else if (cls === CLASSIFICATION.WHITELISTED_DIRECTORY) {
        fanoutTasks.push(item);
      }
      // everything else: drop
    }

    // Process fanouts sequentially (each involves LLM + scraping)
    for (const dirItem of fanoutTasks) {
      const listings = await extractDirectoryListings({
        url: dirItem.result.url,
        scraped: dirItem.scraped,
        directory_identifier: dirItem.result.domain,
      });
      await increment(runId, { haiku_calls_used: 1, serper_calls_used: 0 });

      const toProcess = listings.slice(0, MAX_FANOUT_LISTINGS);
      for (const listing of toProcess) {
        if (listing.website) {
          let domain;
          try { domain = new URL(listing.website).hostname.replace(/^www\./, ''); } catch { continue; }
          if (!domain || seenDomains.has(domain)) continue;
          seenDomains.add(domain);

          const s = await scrapeSite({ domain, page_set: 'homepage_plus_about_contact' });
          const c = await classifyLiveness({ url: listing.website, scraped: s, directory_whitelist: directoryWhitelist });
          await increment(runId, { haiku_calls_used: 1 });

          if (c.classification === CLASSIFICATION.REAL_OPERATING_BUSINESS) {
            candidatePool.push({
              url: listing.website,
              domain,
              title: listing.name,
              scraped: s,
              classification: c,
              discovery_source: 'directory_fanout',
              directory_only: false,
            });
          }
        } else {
          // Directory-only candidate — no website
          candidatePool.push({
            url: listing.listing_url,
            domain: null,
            title: listing.name,
            scraped: null,
            classification: null,
            discovery_source: 'directory_fanout',
            directory_only: true,
            directory_listing: listing,
          });
        }
      }
    }

    console.log(`[ten_leads] ${candidatePool.length} candidates after classification + fanout`);

    if (candidatePool.length === 0) {
      await closeRun(runId, 'completed');
      return finalize({ itp, user_details_id, savedLeads: [], runId });
    }

    // ── Step 7: Load confirmed positives for few-shot ───────────────────
    const confirmedPositives = await loadConfirmedPositives(admin, itp.id);

    // ── Step 8: Score in parallel ───────────────────────────────────────
    await progress(user_details_id, `Scoring ${candidatePool.length} candidates…`, 65);

    const scored = await runParallel(
      candidatePool,
      candidate => scoreCandidate({
        itp,
        account,
        evidence: {
          company_name: candidate.title ?? candidate.domain ?? 'Unknown',
          domain: candidate.domain,
          website_summary: candidate.scraped?.all_text?.slice(0, 600) ?? null,
          directory_only: candidate.directory_only,
        },
        confirmed_positives: confirmedPositives,
      }).then(s => ({ ...candidate, ...s })),
      MAX_SCORE_CONCURRENCY
    );
    await increment(runId, { haiku_calls_used: candidatePool.length });

    // ── Step 9: Filter, rank, cap ───────────────────────────────────────
    const qualified = scored
      .filter(c => c.tier === TIER.A || c.tier === TIER.B)
      .sort((a, b) => b.score - a.score)
      .slice(0, TARGET_CANDIDATES);

    console.log(`[ten_leads] ${qualified.length} tier A/B candidates (from ${scored.length} scored)`);

    // ── Step 10: Persist targets + leads ────────────────────────────────
    await progress(user_details_id, 'Saving results…', 85);
    const savedLeads = [];
    for (const candidate of qualified) {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function progress(user_details_id, message, percent) {
  await broadcastSkillStatus(user_details_id, {
    employee: 'lead_gen_expert',
    skill: 'target_finder_ten_leads',
    status: 'running',
    message: `${message} ${percent}%`,
    persist: false,
  });
}

/**
 * Run async tasks with a concurrency cap.
 */
async function runParallel(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Build a set of all domains already seen on this account (existing targets + customers).
 * Prevents re-surfacing companies we already have.
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

/**
 * Load up to 5 confirmed positives for this ITP to use as few-shot examples in scoring.
 */
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

/**
 * Persist a scored candidate as a target + lead.
 * Returns the lead row, or null if it couldn't be saved.
 */
async function persistCandidate(admin, candidate, itp, accountId) {
  const domain = candidate.domain ?? null;
  const metadata = candidate.classification?.extracted_metadata ?? {};

  // Derive location: prefer postcode from classifier, fall back to directory listing location
  const location = metadata.postcodes?.[0]
    ?? candidate.directory_listing?.location
    ?? null;

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
      target_id: target.id,
      itp_id: itp.id,
      score: candidate.score,
      score_reason: candidate.reasoning ?? null,
      discovery_source: candidate.discovery_source ?? 'serper_direct',
      // approved and confirmed_positive left null — set by user in approval sidebar
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

async function finalize({ itp, user_details_id, savedLeads, runId }) {
  await progress(user_details_id, 'Done!', 100);

  const highScoreCount = savedLeads.length;
  console.log(`[ten_leads] Finished: ${highScoreCount} candidates saved for review`);

  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'target_finder_ten_leads',
    user_details_id,
    output: {
      itp_id: itp.id,
      high_score_count: highScoreCount,
      total_targets: highScoreCount,
    },
  });

  return { user_details_id, itp_id: itp.id, leads: savedLeads };
}
