/**
 * target_finder_100_leads — Phase 3 rewrite
 *
 * Production-quality orchestrator. Finds ~100 auto-approved leads ready for
 * outbound campaigns. Runs up to MAX_ROUNDS search rounds, each generating
 * fresh queries that avoid prior ones, until the lead target is hit.
 *
 * Pipeline per round:
 *   generateQueryProfile → runSearchQueries →
 *   scrapeSite (parallel) → classifyLiveness (parallel) →
 *   directoryFanout (one level) → matchToCompaniesHouse (parallel) →
 *   scoreCandidate (full evidence + few-shot, parallel) →
 *   tier A/B only → persistTarget + approved lead →
 *   enrich_target → addContactsToCampaign
 *
 * Auto-approved leads (approved=true) are distinct from confirmed-positive
 * calibration leads (confirmed_positive=true). This run sets approved=true
 * but NOT confirmed_positive.
 */

import { generateQueryProfile } from '../../../../lib/lead_gen/query_generator.js';
import { runSearchQueries } from '../../../../lib/lead_gen/search_runner.js';
import { scrapeSite } from '../../../../lib/lead_gen/scraper.js';
import { classifyLiveness, CLASSIFICATION } from '../../../../lib/lead_gen/liveness_classifier.js';
import { extractDirectoryListings } from '../../../../lib/lead_gen/directory_fanout.js';
import { matchToCompaniesHouse } from '../../../../lib/lead_gen/ch_matcher.js';
import { scoreCandidate, TIER } from '../../../../lib/lead_gen/itp_scorer.js';
import { executeSkill as runEnrichTarget } from '../enrich_target/index.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';
import { broadcastSkillStatus } from '../../../../intelligence/skill_status_broadcaster/index.js';
import { openRun, increment, closeRun } from '../../../../lib/cost_tracker.js';
import { filterContactsInActiveCampaigns } from '../../../../utils/campaign_contacts.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const RESULTS_PER_QUERY        = 10;
const MAX_SEARCH_RESULTS       = 300;
const MAX_SCRAPE_CONCURRENCY   = 10;
const MAX_CLASSIFY_CONCURRENCY = 8;
const MAX_SCORE_CONCURRENCY    = 8;
const MAX_FANOUT_LISTINGS      = 30;
const TARGET_LEAD_COUNT        = 100;
const APOLLO_REVEALS_CAP       = 5;
const MAX_ROUNDS               = 3;

// ─── Main skill entry point ───────────────────────────────────────────────────

export async function executeSkill({ user_details_id, itp_id, campaign_id = null }) {
  const admin = getSupabaseAdmin();

  const { data: userDetails } = await admin
    .from('user_details').select('account_id').eq('id', user_details_id).single();
  if (!userDetails) throw new Error('target_finder_100_leads: user_details not found');

  let itpQuery = admin.from('itp').select('*').eq('account_id', userDetails.account_id);
  const { data: itp } = itp_id
    ? await itpQuery.eq('id', itp_id).single()
    : await itpQuery.order('created_at', { ascending: false }).limit(1).single();
  if (!itp) throw new Error('target_finder_100_leads: no ITP found for account');

  const { data: account } = await admin
    .from('account').select('*').eq('id', itp.account_id).single();

  const initialApprovedCount = await countApprovedLeads(admin, itp.id);
  const targetCount = initialApprovedCount + TARGET_LEAD_COUNT;
  console.log(`[100_leads] Starting — ${initialApprovedCount} approved leads, targeting ${targetCount} total`);

  const runId = await openRun({
    account_id: userDetails.account_id,
    itp_id: itp.id,
    campaign_id: campaign_id ?? null,
    user_details_id,
  });

  try {
    // ── Step 0: Enrich confirmed-positive calibration leads ────────────
    await progress(user_details_id, 'Enriching calibration leads…', 3);
    await enrichConfirmedPositives({ admin, itp, user_details_id, campaign_id, runId });

    {
      const count = await countApprovedLeads(admin, itp.id);
      if (count >= targetCount) {
        await closeRun(runId, 'completed');
        return finalize({ admin, itp, user_details_id, targetCount, runId });
      }
    }

    // ── Step 2: Account-level dedup (once for the whole run) ────────────
    const seenDomains = await buildDedupSet(admin, userDetails.account_id);

    // ── Step 2.5: Score existing account targets not yet linked to this ITP ──
    await progress(user_details_id, 'Checking existing targets against ITP…', 8);
    const internalLeads = await scoreInternalTargets({ admin, itp, account, runId, seenDomains });
    console.log(`[100_leads] Internal scoring: ${internalLeads.length} existing targets qualified`);
    for (const { target, score, tier, reasoning } of internalLeads) {
      const currentCount = await countApprovedLeads(admin, itp.id);
      if (currentCount >= targetCount) break;

      const { data: lead, error: leadErr } = await admin.from('leads').insert({
        target_id:        target.id,
        itp_id:           itp.id,
        score,
        score_reason:     reasoning ?? null,
        discovery_source: 'internal_database',
        approved:         true,
      }).select('id').single();
      if (leadErr) {
        console.error(`[100_leads] Internal lead insert error for ${target.domain}:`, leadErr.message);
        continue;
      }
      if (target.domain) seenDomains.add(target.domain);
      console.log(`[100_leads] Internal lead: ${target.title ?? target.domain} (score: ${score}, tier: ${tier})`);

      try {
        const enrichResult = await runEnrichTarget({
          target_id:          target.id,
          user_details_id,
          silent:             true,
          runId,
          apollo_reveals_cap: APOLLO_REVEALS_CAP,
        });
        if (enrichResult.already_enriched) {
          const { data: existingContacts } = await admin.from('contacts').select('id').eq('target_id', target.id);
          await addContactsToCampaign(campaign_id, { contacts: existingContacts ?? [] }, user_details_id);
        } else {
          await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
        }
      } catch (err) {
        console.error(`[100_leads] Enrich error for internal target ${target.domain}:`, err.message);
      }
    }
    await increment(runId, { haiku_calls_used: internalLeads.length });

    // ── Steps 3–11: Search rounds ───────────────────────────────────────
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const currentCount = await countApprovedLeads(admin, itp.id);
      if (currentCount >= targetCount) break;

      if (round > 1) {
        console.log(`[100_leads] Round ${round}/${MAX_ROUNDS} — ${currentCount}/${targetCount} leads so far`);
      }

      // Re-fetch ITP to pick up search_profile updates written by previous round
      const { data: freshItp } = await admin.from('itp').select('*').eq('id', itp.id).single();

      const exhausted = await runSearchRound({
        admin,
        itp:            freshItp ?? itp,
        account,
        user_details_id,
        campaign_id,
        runId,
        seenDomains,
        targetCount,
        round,
      });

      if (exhausted) {
        console.log(`[100_leads] Round ${round}: no results — stopping early`);
        break;
      }
    }

    await closeRun(runId, 'completed');
    return finalize({ admin, itp, user_details_id, targetCount, runId });

  } catch (err) {
    console.error('[100_leads] Fatal error:', err.message);
    await closeRun(runId, 'failed', err.message);
    throw err;
  }
}

// ─── Search round ─────────────────────────────────────────────────────────────

/**
 * Run one full search → classify → score → persist round.
 * Mutates seenDomains in place as candidates are saved.
 * Returns true if the round should stop early (no results found).
 */
async function runSearchRound({ admin, itp, account, user_details_id, campaign_id, runId, seenDomains, targetCount, round }) {
  // Progress percentages spread evenly across rounds: round 1 → 10–38%, round 2 → 40–68%, round 3 → 70–95%
  const pct = (fraction) => Math.min(99, Math.round(10 + (round - 1) * 30 + fraction * 28));

  // ── Step 1: Query profile ─────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Building search profile…`, pct(0));
  const queryProfile = await generateQueryProfile({ itp, account });
  const directoryWhitelist = queryProfile.directory_whitelist ?? [];

  // ── Step 3: Search ────────────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Searching for candidates…`, pct(0.1));
  const { results, serper_calls, queries_used } = await runSearchQueries({
    queries:           queryProfile.search_queries ?? [],
    results_per_query: RESULTS_PER_QUERY,
    location:          itp.location,
    max_results:       MAX_SEARCH_RESULTS,
    seen_domains:      seenDomains,
  });
  await increment(runId, { serper_calls_used: serper_calls });
  console.log(`[100_leads] Round ${round}: ${results.length} search results after dedup`);

  if (queries_used.length > 0) {
    await admin.from('target_finder_google_search_prompts').insert(
      queries_used.map(query => ({ itp: itp.id, query }))
    );
  }

  if (results.length === 0) return true;

  // ── Step 4: Scrape ────────────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Scraping ${results.length} pages…`, pct(0.2));
  const scraped = await runParallel(
    results,
    r => scrapeSite({ domain: r.domain, page_set: 'homepage_plus_about_contact' })
        .then(s => ({ result: r, scraped: s })),
    MAX_SCRAPE_CONCURRENCY
  );

  // ── Step 5: Classify ──────────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Analysing pages…`, pct(0.4));
  const classified = await runParallel(
    scraped,
    ({ result, scraped: s }) =>
      classifyLiveness({ url: result.url, scraped: s, directory_whitelist: directoryWhitelist })
        .then(c => ({ result, scraped: s, classification: c })),
    MAX_CLASSIFY_CONCURRENCY
  );
  await increment(runId, { haiku_calls_used: classified.length });

  // ── Step 6: Directory fanout ──────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Following directory listings…`, pct(0.5));
  const candidatePool = [];
  const fanoutTasks = [];

  for (const item of classified) {
    const cls = item.classification.classification;
    if (cls === CLASSIFICATION.REAL_OPERATING_BUSINESS) {
      candidatePool.push({
        url:              item.result.url,
        domain:           item.result.domain,
        title:            item.result.title,
        scraped:          item.scraped,
        classification:   item.classification,
        discovery_source: 'serper_direct',
        directory_only:   false,
      });
    } else if (cls === CLASSIFICATION.WHITELISTED_DIRECTORY) {
      fanoutTasks.push(item);
    }
  }

  for (const dirItem of fanoutTasks) {
    const listings = await extractDirectoryListings({
      url:                  dirItem.result.url,
      scraped:              dirItem.scraped,
      directory_identifier: dirItem.result.domain,
    });
    await increment(runId, { haiku_calls_used: 1 });

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
            url:              listing.website,
            domain,
            title:            listing.name,
            scraped:          s,
            classification:   c,
            discovery_source: 'directory_fanout',
            directory_only:   false,
          });
        }
      } else {
        candidatePool.push({
          url:               listing.listing_url,
          domain:            null,
          title:             listing.name,
          scraped:           null,
          classification:    null,
          discovery_source:  'directory_fanout',
          directory_only:    true,
          directory_listing: listing,
        });
      }
    }
  }

  console.log(`[100_leads] Round ${round}: ${candidatePool.length} candidates after classification + fanout`);
  if (candidatePool.length === 0) return true;

  // ── Step 7: CH match ──────────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Matching to Companies House…`, pct(0.6));
  const chMatched = await runParallel(
    candidatePool,
    async candidate => {
      if (candidate.directory_only) return { ...candidate, ch: { matched: false } };
      const metadata = candidate.classification?.extracted_metadata ?? {};
      const ch = await matchToCompaniesHouse({
        name:                candidate.title,
        postcode:            metadata.postcodes?.[0] ?? candidate.directory_listing?.location ?? null,
        registration_number: metadata.registration_number ?? null,
        phone:               metadata.phones?.[0] ?? null,
      }).catch(() => ({ matched: false }));
      return { ...candidate, ch };
    },
    MAX_SCORE_CONCURRENCY
  );

  // ── Step 8: Confirmed positives for few-shot ──────────────────────────
  const confirmedPositives = await loadConfirmedPositives(admin, itp.id);

  // ── Step 9: Score ─────────────────────────────────────────────────────
  await progress(user_details_id, `Round ${round}: Scoring ${chMatched.length} candidates…`, pct(0.7));
  const scored = await runParallel(
    chMatched,
    candidate => scoreCandidate({
      itp,
      account,
      evidence: {
        company_name:        candidate.title ?? candidate.domain ?? 'Unknown',
        domain:              candidate.domain,
        website_summary:     candidate.scraped?.all_text?.slice(0, 800) ?? null,
        directory_only:      candidate.directory_only,
        ch_data:             candidate.ch?.ch_record ?? null,
        ch_match_confidence: candidate.ch?.match_confidence ?? null,
      },
      confirmed_positives: confirmedPositives,
    }).then(s => ({ ...candidate, ...s })),
    MAX_SCORE_CONCURRENCY
  );
  await increment(runId, { haiku_calls_used: candidatePool.length });

  // ── Step 10: Filter tier A/B, sort by score ───────────────────────────
  const qualified = scored
    .filter(c => c.tier === TIER.A || c.tier === TIER.B)
    .sort((a, b) => b.score - a.score);
  console.log(`[100_leads] Round ${round}: ${qualified.length} tier A/B candidates (from ${scored.length} scored)`);

  // ── Step 11: Persist + enrich + sync to campaign ──────────────────────
  await progress(user_details_id, `Round ${round}: Enriching ${qualified.length} qualified leads…`, pct(0.8));
  let enrichedCount = 0;

  for (const candidate of qualified) {
    const currentCount = await countApprovedLeads(admin, itp.id);
    if (currentCount >= targetCount) break;

    const saved = await persistCandidate(admin, candidate, itp, account.id);
    if (!saved) continue;

    if (candidate.domain) seenDomains.add(candidate.domain);

    try {
      const enrichResult = await runEnrichTarget({
        target_id:          saved.target_id,
        user_details_id,
        silent:             true,
        runId,
        apollo_reveals_cap: APOLLO_REVEALS_CAP,
      });
      if (enrichResult.already_enriched) {
        // Target was enriched in a previous run — load existing contacts and add to campaign
        const { data: existingContacts } = await admin.from('contacts').select('id').eq('target_id', saved.target_id);
        await addContactsToCampaign(campaign_id, { contacts: existingContacts ?? [] }, user_details_id);
      } else {
        await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
      }
      enrichedCount++;
      console.log(`[100_leads] Round ${round}: Enriched ${enrichedCount}: ${candidate.title ?? candidate.domain}`);
    } catch (err) {
      console.error(`[100_leads] Enrich error for ${candidate.title ?? candidate.domain}:`, err.message);
    }
  }

  console.log(`[100_leads] Round ${round}: complete — ${enrichedCount} new leads enriched`);
  return false;
}

// ─── Step 0 helper: enrich confirmed-positive calibration leads ───────────────

async function enrichConfirmedPositives({ admin, itp, user_details_id, campaign_id, runId }) {
  const { data: leads } = await admin
    .from('leads')
    .select('id, target_id, targets(id, enriched_at, domain)')
    .eq('itp_id', itp.id)
    .eq('confirmed_positive', true);

  const unenriched = (leads ?? []).filter(l => l.targets && !l.targets.enriched_at && l.targets.domain);
  if (!unenriched.length) {
    console.log('[100_leads] No unenriched calibration leads to process');
    return;
  }

  console.log(`[100_leads] Enriching ${unenriched.length} confirmed-positive calibration lead(s)`);

  for (const lead of unenriched) {
    try {
      const enrichResult = await runEnrichTarget({
        target_id:          lead.target_id,
        user_details_id,
        silent:             true,
        runId,
        apollo_reveals_cap: APOLLO_REVEALS_CAP,
      });
      await addContactsToCampaign(campaign_id, enrichResult, user_details_id);
      console.log(`[100_leads] Enriched calibration lead: target ${lead.target_id}`);
    } catch (err) {
      console.error(`[100_leads] Calibration enrich error for target ${lead.target_id}:`, err.message);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function progress(user_details_id, message, percent) {
  await broadcastSkillStatus(user_details_id, {
    employee: 'lead_gen_expert',
    skill:    'target_finder_100_leads',
    status:   'running',
    message:  `${message} ${percent}%`,
    persist:  false,
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
 * Count all approved leads for this ITP.
 */
async function countApprovedLeads(admin, itpId) {
  const { data } = await admin
    .from('leads').select('id').eq('itp_id', itpId).eq('approved', true);
  return data?.length ?? 0;
}

/**
 * Score existing account targets that don't yet have a lead for this ITP.
 * Returns targets that pass the A/B threshold, sorted by score descending.
 * No re-scraping — scores from title + domain only.
 */
async function scoreInternalTargets({ admin, itp, account, runId, seenDomains }) {
  // Domains already linked to this ITP
  const { data: thisItpLeads } = await admin
    .from('leads').select('targets(domain)').eq('itp_id', itp.id);
  const alreadyLinked = new Set(
    (thisItpLeads ?? []).map(l => l.targets?.domain).filter(Boolean)
  );

  // Candidate domains: in account's pool but not yet for this ITP
  const candidateDomains = [...seenDomains].filter(d => !alreadyLinked.has(d));
  if (!candidateDomains.length) return [];

  // Fetch target records for those domains (in batches of 100 to avoid URL limits)
  const allTargets = [];
  for (let i = 0; i < candidateDomains.length; i += 100) {
    const batch = candidateDomains.slice(i, i + 100);
    const { data } = await admin
      .from('targets').select('id, title, domain, company_location')
      .in('domain', batch);
    if (data) allTargets.push(...data);
  }
  if (!allTargets.length) return [];

  console.log(`[100_leads] Scoring ${allTargets.length} internal targets against this ITP…`);

  const confirmed_positives = await loadConfirmedPositives(admin, itp.id);

  const results = await runParallel(allTargets, async (target) => {
    const result = await scoreCandidate({
      itp,
      account,
      evidence: {
        company_name:     target.title,
        domain:           target.domain,
        discovery_source: 'internal_database',
      },
      confirmed_positives,
    });
    if (result.tier === TIER.A || result.tier === TIER.B) {
      return { target, ...result };
    }
    return null;
  }, MAX_SCORE_CONCURRENCY);

  return results
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

/**
 * Build a set of all domains already seen on this account.
 * Prevents re-surfacing companies already in the system.
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
 * Load up to 5 confirmed positives for few-shot scoring examples.
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
    title:        l.targets?.title  ?? l.targets?.domain ?? 'Unknown',
    domain:       l.targets?.domain ?? null,
    score_reason: l.score_reason    ?? null,
  }));
}

/**
 * Persist a scored candidate as a target + auto-approved lead.
 * Includes CH data on the target when available.
 * Returns { target_id, lead_id } or null on failure.
 */
async function persistCandidate(admin, candidate, itp, accountId) {
  const domain   = candidate.domain ?? null;
  const metadata = candidate.classification?.extracted_metadata ?? {};
  const chRecord = candidate.ch?.ch_record ?? null;

  // Prefer postcode from liveness classifier, then CH address, then directory listing
  const location = metadata.postcodes?.[0]
    ?? (chRecord
        ? [chRecord.registered_office_address?.locality, chRecord.registered_office_address?.region]
            .filter(Boolean).join(', ')
        : null)
    ?? candidate.directory_listing?.location
    ?? null;

  // Check if a target with this domain already exists (global unique constraint on domain)
  let target = null;
  if (domain) {
    const { data: existing } = await admin.from('targets').select('id').eq('domain', domain).maybeSingle();
    if (existing) target = existing;
  }

  if (!target) {
    const { data: inserted, error: targetErr } = await admin
      .from('targets')
      .insert({
        domain,
        title:                   candidate.title ?? domain ?? 'Unknown',
        link:                    domain ? `https://${domain}` : (candidate.url ?? null),
        company_location:        location,
        companies_house_number:  chRecord?.company_number ?? null,
      })
      .select('id')
      .single();

    if (targetErr) {
      console.error(`[100_leads] Target insert error for ${domain}:`, targetErr.message);
      return null;
    }
    target = inserted;
  }

  // Save CH officers as skeleton contacts (email filled later by enrich_target)
  const officers = candidate.ch?.officers ?? [];
  for (const officer of officers) {
    if (!officer.first_name && !officer.last_name) continue;
    try {
      await admin.from('contacts').insert({
        target_id:  target.id,
        account_id: accountId,
        first_name: officer.first_name ?? null,
        last_name:  officer.last_name  ?? null,
        role:       officer.role       ?? null,
        email:      null,
        source:     'companies_house',
      });
    } catch { /* ignore duplicate errors */ }
  }

  const { data: lead, error: leadErr } = await admin
    .from('leads')
    .insert({
      target_id:        target.id,
      itp_id:           itp.id,
      score:            candidate.score,
      score_reason:     candidate.reasoning ?? null,
      discovery_source: candidate.discovery_source ?? 'serper_direct',
      approved:         true,
    })
    .select('id')
    .single();

  if (leadErr) {
    console.error(`[100_leads] Lead insert error for ${domain}:`, leadErr.message);
    return null;
  }

  console.log(`[100_leads] Saved: ${candidate.title ?? domain} (score: ${candidate.score}, tier: ${candidate.tier})`);
  return { target_id: target.id, lead_id: lead.id };
}

/**
 * Add enriched contacts to the active campaign and sync to Smartlead.
 * Preserves cross-campaign deduplication from the original orchestrator.
 */
async function addContactsToCampaign(campaign_id, enrichResult, user_details_id) {
  if (!campaign_id || !enrichResult?.contacts?.length) return;
  const admin = getSupabaseAdmin();

  // Filter out contacts already in this campaign
  const incomingIds = enrichResult.contacts.map(c => c.id);
  const { data: alreadyIn } = await admin
    .from('campaign_contacts').select('contact_id')
    .eq('campaign_id', campaign_id).in('contact_id', incomingIds);
  const alreadyInSet = new Set((alreadyIn ?? []).map(r => r.contact_id));
  const newContacts = enrichResult.contacts.filter(c => !alreadyInSet.has(c.id));

  if (!newContacts.length) return;

  // Cross-campaign dedup: skip contacts already in another active campaign for this account
  const { data: campaignRow } = await admin
    .from('campaigns').select('smartlead_campaign_id, account_id').eq('id', campaign_id).single();

  const crossFilteredIds = campaignRow?.account_id
    ? await filterContactsInActiveCampaigns({
        accountId:           campaignRow.account_id,
        currentCampaignId:   campaign_id,
        candidateContactIds: newContacts.map(c => c.id),
      })
    : newContacts.map(c => c.id);
  const crossFilteredSet = new Set(crossFilteredIds);
  const filteredContacts = newContacts.filter(c => crossFilteredSet.has(c.id));

  if (!filteredContacts.length) return;

  for (const contact of filteredContacts) {
    const { error } = await admin
      .from('campaign_contacts')
      .insert({ campaign_id, contact_id: contact.id })
      .select('id').single();
    if (error && !error.message?.includes('duplicate')) {
      console.error('[100_leads] campaign_contacts insert error:', error.message);
    }
  }
  console.log(`[100_leads] Added ${filteredContacts.length} contacts to campaign ${campaign_id}`);

  // Sync to Smartlead if the campaign has a smartlead_campaign_id
  if (campaignRow?.smartlead_campaign_id) {
    try {
      const { addLeads } = await import('../../../../config/smartlead.js');
      const newContactIds = filteredContacts.map(c => c.id);
      const { data: contactRows } = await admin
        .from('contacts')
        .select('id, first_name, last_name, email, role, phone, linkedin_url, target_id, targets(title, domain, company_location, industry)')
        .in('id', newContactIds);

      const slLeads = (contactRows ?? []).filter(c => c.email).map(c => ({
        email:        c.email,
        first_name:   c.first_name ?? '',
        last_name:    c.last_name  ?? '',
        company_name: c.targets?.title  ?? '',
        website:      c.targets?.domain ? `https://${c.targets.domain}` : '',
        custom_fields: {
          job_title: c.role             ?? '',
          industry:  c.targets?.industry ?? '',
        },
      }));

      if (slLeads.length) {
        const slCampaignId = parseInt(campaignRow.smartlead_campaign_id);
        if (isNaN(slCampaignId)) {
          console.warn(`[100_leads] smartlead_campaign_id "${campaignRow.smartlead_campaign_id}" is not a valid integer — skipping Smartlead push`);
          return;
        }

        await addLeads(slCampaignId, slLeads);

        // Mark campaign_contacts rows as synced
        for (const contact of filteredContacts) {
          const { data: cc } = await admin
            .from('campaign_contacts').select('id')
            .eq('campaign_id', campaign_id).eq('contact_id', contact.id).maybeSingle();
          if (cc) {
            await admin.from('campaign_contacts').update({ smartlead_synced: true }).eq('id', cc.id);
          }
        }

        console.log(`[100_leads] Pushed ${slLeads.length} contacts to Smartlead`);
      }
    } catch (err) {
      console.error('[100_leads] Smartlead push error:', err.message);
    }
  }
}

/**
 * Finalise the run — emit processSkillOutput for the app message.
 */
async function finalize({ admin, itp, user_details_id, targetCount, runId }) {
  await progress(user_details_id, 'Done!', 100);

  const { data: finalLeads } = await admin
    .from('leads')
    .select('id, approved')
    .eq('itp_id', itp.id);

  const approvedCount = (finalLeads ?? []).filter(l => l.approved).length;
  console.log(`[100_leads] Finished — ${approvedCount} approved leads`);

  await processSkillOutput({
    employee:        'lead_gen_expert',
    skill_name:      'target_finder_100_leads',
    user_details_id,
    output: {
      itp_id:         itp.id,
      approved_count: approvedCount,
      target_count:   targetCount,
      total_leads:    (finalLeads ?? []).length,
    },
  });

  return { user_details_id, itp_id: itp.id, approved_count: approvedCount };
}
