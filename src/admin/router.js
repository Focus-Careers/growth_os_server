import express from 'express';
import cron from 'node-cron';
import { getSupabaseAdmin } from '../config/supabase.js';
import { dispatchSkill } from '../employees/index.js';
import { addJob, removeJob, pauseJob, resumeJob } from './cronService.js';
import {
  createCampaign as slCreateCampaign,
  saveSequences,
  setSchedule,
  setCampaignSettings,
  attachEmailAccount,
  addLeads,
  registerCampaignWebhook,
  updateCampaignStatus,
  getCampaigns as slGetCampaigns,
} from '../config/smartlead.js';
import { resolveSmartleadSender } from '../employees/email_campaign_manager/helpers/resolve_smartlead_sender.js';

const router = express.Router();

async function requireSuperAdmin(req, res) {
  const { user_details_id } = req.body;
  if (!user_details_id) {
    res.status(400).json({ error: 'user_details_id required' });
    return null;
  }
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) {
    res.status(403).json({ error: 'Super admin access required' });
    return null;
  }
  return supabase;
}

// GET /api/admin/verify
router.get('/verify', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  res.json({ isSuperAdmin: data?.is_super_admin ?? false });
});

// GET /api/admin/health
router.get('/health', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const dayAgo     = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const twoHrsAgo  = new Date(Date.now() -  2 * 60 * 60 * 1000).toISOString();

  const [
    { count: failed_runs_24h },
    { count: stuck_runs },
    { count: active_crons },
  ] = await Promise.all([
    supabase.from('lead_generation_runs').select('*', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', dayAgo),
    supabase.from('lead_generation_runs').select('*', { count: 'exact', head: true }).eq('status', 'running').lt('created_at', twoHrsAgo),
    supabase.from('target_finder_crons').select('*', { count: 'exact', head: true }).eq('active', true),
  ]);

  const status = (failed_runs_24h > 0 || stuck_runs > 0) ? 'error'
    : (active_crons === 0) ? 'warning'
    : 'ok';

  res.json({ status, failed_runs_24h: failed_runs_24h ?? 0, stuck_runs: stuck_runs ?? 0, active_crons: active_crons ?? 0 });
});

// GET /api/admin/campaigns
router.get('/campaigns', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id, name, status, account_id, itp_id, smartlead_campaign_id, account:account(organisation_name), itp(name)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ campaigns });
});

// GET /api/admin/analytics
router.get('/analytics', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const now = Date.now();
  const weekAgo     = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalLeads },
    { data: scoresThisWeek },
    { data: scoresLastWeek },
    { count: totalCampaignContacts },
    { count: totalCampaigns },
    { count: totalCompanies },
    { count: leadsThisWeek },
    { count: leadsLastWeek },
    { count: contactsThisWeek },
    { count: contactsLastWeek },
    { count: campaignsThisWeek },
    { count: campaignsLastWeek },
    { count: companiesThisWeek },
    { count: companiesLastWeek },
    { data: recentRuns },
    { data: accounts },
    { data: leadsRaw },
    { data: contactsRaw },
    { data: campaignsRaw },
    { data: companiesRaw },
  ] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }),
    supabase.from('leads').select('score').not('score', 'is', null).gte('created_at', weekAgo),
    supabase.from('leads').select('score').not('score', 'is', null).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('account').select('*', { count: 'exact', head: true }),
    supabase.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    supabase.from('account').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('account').select('*', { count: 'exact', head: true }).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    supabase.from('lead_generation_runs')
      .select('id, campaign_id, status, estimated_cost_pence, created_at, campaigns(name, account_id, itp_id, account(organisation_name))')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('account')
      .select('id, organisation_name, campaigns(id, name, status, itp_id)'),
    supabase.from('leads').select('created_at, score, itp_id').gte('created_at', twoWeeksAgo),
    supabase.from('campaign_contacts').select('created_at').gte('created_at', twoWeeksAgo),
    supabase.from('campaigns').select('created_at').gte('created_at', twoWeeksAgo),
    supabase.from('account').select('created_at').gte('created_at', twoWeeksAgo),
  ]);

  // Attach lead_count to each run using itp_id + 12-hour time window heuristic
  const RUN_WINDOW_MS = 12 * 60 * 60 * 1000;
  const enrichedRuns = (recentRuns || []).map(run => {
    const itpId = run.campaigns?.itp_id;
    if (!itpId) return { ...run, lead_count: null };
    const runStart = new Date(run.created_at).getTime();
    const count = (leadsRaw || []).filter(l => {
      if (l.itp_id !== itpId) return false;
      const t = new Date(l.created_at).getTime();
      return t >= runStart && t < runStart + RUN_WINDOW_MS;
    }).length;
    return { ...run, lead_count: count };
  });

  const avg = (rows) => rows?.length ? Math.round(rows.reduce((s, l) => s + (l.score || 0), 0) / rows.length) : 0;
  const avgScore         = avg(scoresThisWeek);
  const avgScoreLastWeek = avg(scoresLastWeek);

  // Build 14-point daily spark arrays
  const bucket = (rows, valueFn) => Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now - (13 - i) * 24 * 60 * 60 * 1000);
    d.setHours(0, 0, 0, 0);
    const end = new Date(d); end.setDate(end.getDate() + 1);
    const slice = (rows || []).filter(r => { const t = new Date(r.created_at); return t >= d && t < end; });
    return valueFn(slice);
  });
  const sparks = {
    leads:    bucket(leadsRaw, s => s.length),
    contacts: bucket(contactsRaw, s => s.length),
    campaigns:bucket(campaignsRaw, s => s.length),
    companies:bucket(companiesRaw, s => s.length),
    avgScore: bucket(leadsRaw, s => {
      const scored = s.filter(r => r.score != null);
      return scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : 0;
    }),
  };

  // Build itp_id → account_id map for time-series bucketing
  const itpToAccountId = {};
  (accounts || []).forEach(a => {
    (a.campaigns || []).forEach(c => { if (c.itp_id) itpToAccountId[c.itp_id] = a.id; });
  });

  // Group leadsRaw by account for time-series — no extra DB queries needed
  const recentLeadsByAccount = {};
  (leadsRaw || []).forEach(l => {
    const aid = itpToAccountId[l.itp_id];
    if (!aid) return;
    if (!recentLeadsByAccount[aid]) recentLeadsByAccount[aid] = [];
    recentLeadsByAccount[aid].push(l);
  });

  const dayBucket = (rows, nDays) => Array.from({ length: nDays }, (_, i) => {
    const d = new Date(now - (nDays - 1 - i) * 24 * 60 * 60 * 1000);
    d.setHours(0, 0, 0, 0);
    const end = new Date(d); end.setDate(end.getDate() + 1);
    return (rows || []).filter(r => { const t = new Date(r.created_at); return t >= d && t < end; }).length;
  });

  // Per-company lead + contact counts
  const accountIds = (accounts || []).map(a => a.id);
  const perCompany = await Promise.all(accountIds.map(async (account_id) => {
    const account = accounts.find(a => a.id === account_id);
    const campaignIds = (account.campaigns || []).map(c => c.id);
    if (campaignIds.length === 0) return {
      account_id, account_name: account.organisation_name, campaigns: account.campaigns,
      leadCount: 0, contactCount: 0, leadCountThisWeek: 0, leadSeries: Array(7).fill(0),
    };

    const itpIds = [...new Set((account.campaigns || []).map(c => c.itp_id).filter(Boolean))];
    const recentLeads = recentLeadsByAccount[account_id] || [];
    const weekAgoDate = new Date(weekAgo);

    const [{ count: leadCount }, { count: contactCount }] = await Promise.all([
      supabase.from('leads').select('*', { count: 'exact', head: true }).in('itp_id', itpIds),
      supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }).in('campaign_id', campaignIds),
    ]);

    return {
      account_id, account_name: account.organisation_name, campaigns: account.campaigns,
      leadCount: leadCount ?? 0,
      contactCount: contactCount ?? 0,
      leadCountThisWeek: recentLeads.filter(l => new Date(l.created_at) >= weekAgoDate).length,
      leadSeries: dayBucket(recentLeads, 7),
    };
  }));

  res.json({
    aggregated: {
      totalLeads, avgScore, totalCampaignContacts, totalCampaigns, totalCompanies,
      leadsThisWeek, leadsLastWeek,
      contactsThisWeek, contactsLastWeek,
      avgScoreLastWeek,
      campaignsThisWeek, campaignsLastWeek,
      companiesThisWeek, companiesLastWeek,
      sparks,
    },
    recentRuns: enrichedRuns,
    perCompany,
  });
});

// POST /api/admin/target-finder/run
router.post('/target-finder/run', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { campaign_ids } = req.body;
  if (!Array.isArray(campaign_ids) || campaign_ids.length === 0) {
    return res.status(400).json({ error: 'campaign_ids array required' });
  }

  res.json({ dispatched: true, campaign_ids });

  for (const campaign_id of campaign_ids) {
    const { data: campaign } = await supabase
      .from('campaigns').select('account_id, itp_id').eq('id', campaign_id).single();
    if (!campaign?.itp_id) continue;

    const { data: ud } = await supabase
      .from('user_details').select('id').eq('account_id', campaign.account_id).limit(1).single();
    if (!ud) continue;

    dispatchSkill('lead_gen_expert', 'target_finder_100_leads', {
      user_details_id: ud.id,
      itp_id: campaign.itp_id,
      campaign_id,
    }).catch(err => console.error(`[admin/run] dispatch error for campaign ${campaign_id}:`, err));
  }
});

// GET /api/admin/crons
router.get('/crons', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const { data: crons, error } = await supabase
    .from('target_finder_crons')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Resolve campaign names + itp_ids in one query
  const allCampaignIds = [...new Set((crons || []).flatMap(c => c.campaign_ids))];
  let campaignNames = {};
  let campaignItpMap = {};
  if (allCampaignIds.length > 0) {
    const { data: camps } = await supabase
      .from('campaigns')
      .select('id, name, itp_id, account:account(organisation_name)')
      .in('id', allCampaignIds);
    (camps || []).forEach(c => {
      campaignNames[c.id] = { name: c.name, company: c.account?.organisation_name };
      campaignItpMap[c.id] = c.itp_id;
    });
  }

  // For each cron with last_run_at, count leads created since then
  const enriched = await Promise.all((crons || []).map(async (c) => {
    let last_run_leads = null;
    if (c.last_run_at && c.campaign_ids?.length > 0) {
      const itpIds = [...new Set(c.campaign_ids.map(id => campaignItpMap[id]).filter(Boolean))];
      if (itpIds.length > 0) {
        const { count } = await supabase
          .from('leads').select('*', { count: 'exact', head: true })
          .in('itp_id', itpIds)
          .gte('created_at', c.last_run_at);
        last_run_leads = count ?? 0;
      }
    }
    return {
      ...c,
      campaigns: c.campaign_ids.map(id => ({ id, ...(campaignNames[id] || { name: 'Unknown', company: '' }) })),
      last_run_leads,
    };
  }));

  res.json({ crons: enriched });
});

// POST /api/admin/crons
router.post('/crons', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { user_details_id, label, campaign_ids, cron_expression, timezone } = req.body;
  if (!label || !Array.isArray(campaign_ids) || campaign_ids.length === 0 || !cron_expression) {
    return res.status(400).json({ error: 'label, campaign_ids, and cron_expression required' });
  }
  if (!cron.validate(cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const { data, error } = await supabase
    .from('target_finder_crons')
    .insert({ label, campaign_ids, cron_expression, timezone: timezone ?? null, created_by: user_details_id, active: true })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  addJob(data);
  res.json({ cron: data });
});

// PATCH /api/admin/crons/:id
router.patch('/crons/:id', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { id } = req.params;
  const { active, label, campaign_ids, cron_expression } = req.body;

  const updates = {};
  if (label !== undefined) updates.label = label;
  if (campaign_ids !== undefined) updates.campaign_ids = campaign_ids;
  if (cron_expression !== undefined) {
    if (!cron.validate(cron_expression)) return res.status(400).json({ error: 'Invalid cron expression' });
    updates.cron_expression = cron_expression;
  }
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('target_finder_crons').update(updates).eq('id', id).select().single();

  if (error) return res.status(500).json({ error: error.message });

  if (active === false) pauseJob(id);
  else if (active === true) resumeJob(data);
  else if (cron_expression || campaign_ids) resumeJob(data);

  res.json({ cron: data });
});

// DELETE /api/admin/crons/:id
router.delete('/crons/:id', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { id } = req.params;
  const { error } = await supabase.from('target_finder_crons').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  removeJob(id);
  res.json({ deleted: true });
});

// GET /api/admin/smartlead/status
router.get('/smartlead/status', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const { data: config } = await supabase.from('smartlead_config').select('*').eq('id', 1).single();

  const apiKey = process.env.SMARTLEAD_API_KEY;
  let connected = false;
  let connectError = null;

  if (!apiKey) {
    connectError = 'SMARTLEAD_API_KEY env var is not set';
    console.error('[admin/smartlead]', connectError);
  } else {
    try {
      const pingRes = await fetch(`https://server.smartlead.ai/api/v1/campaigns?limit=1&offset=0&api_key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = await pingRes.text();
      connected = pingRes.ok;
      if (!pingRes.ok) {
        connectError = `HTTP ${pingRes.status}: ${body.slice(0, 300)}`;
        console.error('[admin/smartlead] ping failed:', connectError);
      }
    } catch (err) {
      connectError = `${err.name}: ${err.message}`;
      console.error('[admin/smartlead] ping error:', connectError);
    }
  }

  // Determine current Smartlead campaign sending status
  let campaignStatus = null; // 'ACTIVE' | 'PAUSED' | 'MIXED' | null
  if (connected) {
    const { data: ourCampaigns } = await supabase
      .from('campaigns')
      .select('smartlead_campaign_id')
      .not('smartlead_campaign_id', 'is', null)
      .neq('smartlead_campaign_id', 'syncing');

    const ourIds = new Set((ourCampaigns || []).map(c => String(c.smartlead_campaign_id)));

    if (ourIds.size > 0) {
      const slCampaigns = await slGetCampaigns();
      const relevant = slCampaigns.filter(c => ourIds.has(String(c.id)));
      if (relevant.length > 0) {
        const allActive = relevant.every(c => c.status === 'START');
        const allPaused = relevant.every(c => c.status !== 'START');
        campaignStatus = allActive ? 'ACTIVE' : allPaused ? 'PAUSED' : 'MIXED';
      }
    }
  }

  res.json({ sync_enabled: config?.sync_enabled ?? true, connected, connectError, campaignStatus, updated_at: config?.updated_at });
});

// POST /api/admin/smartlead/toggle
router.post('/smartlead/toggle', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { data: current } = await supabase.from('smartlead_config').select('sync_enabled').eq('id', 1).single();
  const newValue = !(current?.sync_enabled ?? true);

  const { data, error } = await supabase
    .from('smartlead_config')
    .update({ sync_enabled: newValue, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ sync_enabled: data.sync_enabled });
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const user_details_id = req.query.user_details_id;
  if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
  const supabase = getSupabaseAdmin();
  const { data: requester } = await supabase
    .from('user_details').select('is_super_admin').eq('id', user_details_id).single();
  if (!requester?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });

  const { data: users, error } = await supabase
    .from('user_details')
    .select('id, auth_id, firstname, role, is_super_admin, account_id')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Fetch account names separately to avoid join alias issues
  const accountIds = [...new Set((users || []).map(u => u.account_id).filter(Boolean))];
  const accountNameMap = {};
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase.from('account').select('id, organisation_name').in('id', accountIds);
    (accounts || []).forEach(a => { accountNameMap[a.id] = a.organisation_name; });
  }

  // Get emails from auth.users via admin API
  const { data: { users: authUsers } } = await supabase.auth.admin.listUsers();
  const emailMap = {};
  (authUsers || []).forEach(u => { emailMap[u.id] = u.email; });

  // Group by auth_id — one entry per real user, with all companies listed
  const grouped = {};
  (users || []).forEach(u => {
    const authId = u.auth_id ?? u.id;
    if (!grouped[authId]) {
      grouped[authId] = {
        auth_id: authId,
        email: emailMap[authId] ?? null,
        firstname: u.firstname,
        is_super_admin: u.is_super_admin,
        companies: [],
      };
    }
    grouped[authId].is_super_admin = grouped[authId].is_super_admin || u.is_super_admin;
    grouped[authId].companies.push({
      user_details_id: u.id,
      account_id: u.account_id,
      account_name: u.account_id ? (accountNameMap[u.account_id] ?? null) : null,
      role: u.role,
    });
  });

  res.json({ users: Object.values(grouped) });
});

async function runSyncAll(supabase) {
  const results = { created: 0, contacts_pushed: 0, skipped: 0, errors: [] };

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, smartlead_campaign_id, sender_id, email_sequence, subject_line, email_template, schedule')
    .eq('status', 'active');

  // Build set of valid Smartlead campaign IDs to detect stale references
  const slCampaignList = await slGetCampaigns();
  const validSlIds = new Set(slCampaignList.map(c => String(c.id)));

  async function createInSmartlead(campaign) {
    const slCampaign = await slCreateCampaign(campaign.name);
    if (!slCampaign?.id) return null;
    await supabase.from('campaigns').update({ smartlead_campaign_id: String(slCampaign.id) }).eq('id', campaign.id);
    let sequences = campaign.email_sequence;
    if (!sequences?.length) {
      sequences = [{ seq_number: 1, delay_in_days: 0, subject: campaign.subject_line ?? campaign.name, body: campaign.email_template ?? '<p>Hi {{first_name}},</p>' }];
    }
    await saveSequences(slCampaign.id, sequences);
    await setSchedule(slCampaign.id, campaign.schedule ?? {});
    await setCampaignSettings(slCampaign.id);
    if (process.env.WEBHOOK_BASE_URL) {
      await registerCampaignWebhook(slCampaign.id, `${process.env.WEBHOOK_BASE_URL}/api/webhooks/smartlead`);
    }
    if (campaign.sender_id) {
      const { slEmailAccountId } = await resolveSmartleadSender(campaign.sender_id);
      if (slEmailAccountId) await attachEmailAccount(slCampaign.id, parseInt(slEmailAccountId));
    }
    return String(slCampaign.id);
  }

  for (const campaign of campaigns || []) {
    try {
      const hasStaleId = campaign.smartlead_campaign_id &&
        campaign.smartlead_campaign_id !== 'syncing' &&
        !validSlIds.has(String(campaign.smartlead_campaign_id));

      const needsCreate = !campaign.smartlead_campaign_id ||
        campaign.smartlead_campaign_id === 'syncing' ||
        hasStaleId;

      if (needsCreate) {
        if (hasStaleId) {
          await supabase.from('campaigns').update({ smartlead_campaign_id: null }).eq('id', campaign.id);
          campaign.smartlead_campaign_id = null;
          console.log(`[admin/sync-all] Stale Smartlead ID for campaign ${campaign.id}, recreating`);
        }

        const { data: claimed } = await supabase
          .from('campaigns')
          .update({ smartlead_campaign_id: 'syncing' })
          .eq('id', campaign.id)
          .is('smartlead_campaign_id', null)
          .select('id').single();

        if (!claimed) { results.skipped++; continue; }

        const newSlId = await createInSmartlead(campaign);
        if (!newSlId) { results.errors.push(`${campaign.id}: create failed`); continue; }

        campaign.smartlead_campaign_id = newSlId;
        results.created++;
      }

      // Push any unsynced contacts
      const slId = parseInt(campaign.smartlead_campaign_id);
      if (!slId) continue;

      const { data: unsynced } = await supabase
        .from('campaign_contacts')
        .select('id, contacts(first_name, last_name, email, role, linkedin_url, targets(title, domain, company_location, industry))')
        .eq('campaign_id', campaign.id)
        .eq('smartlead_synced', false);

      if (unsynced?.length) {
        const leads = unsynced.filter(cc => cc.contacts?.email).map(cc => ({
          email: cc.contacts.email,
          first_name: cc.contacts.first_name ?? '',
          last_name: cc.contacts.last_name ?? '',
          company_name: cc.contacts.targets?.title ?? '',
          website: cc.contacts.targets?.domain ? `https://${cc.contacts.targets.domain}` : '',
          linkedin_profile: cc.contacts.linkedin_url ?? '',
          location: cc.contacts.targets?.company_location ?? '',
          custom_fields: { job_title: cc.contacts.role ?? '', industry: cc.contacts.targets?.industry ?? '' },
        }));

        const syncedIds = [];
        for (let i = 0; i < leads.length; i += 100) {
          const batch = leads.slice(i, i + 100);
          const ok = await addLeads(slId, batch);
          if (ok) syncedIds.push(...unsynced.slice(i, i + 100).map(cc => cc.id));
          else results.errors.push(`campaign ${campaign.id}: batch ${Math.floor(i / 100) + 1} failed`);
        }
        if (syncedIds.length) {
          await supabase.from('campaign_contacts').update({ smartlead_synced: true }).in('id', syncedIds);
          results.contacts_pushed += syncedIds.length;
        }
      }
    } catch (err) {
      console.error(`[admin/sync-all] campaign ${campaign.id}:`, err.message);
      results.errors.push(`${campaign.id}: ${err.message}`);
    }
  }

  console.log('[admin/sync-all] Done:', results);
  return results;
}

// POST /api/admin/smartlead/sync-all
router.post('/smartlead/sync-all', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  try {
    const results = await runSyncAll(supabase);
    res.json(results);
  } catch (err) {
    console.error('[admin/sync-all] fatal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/smartlead/set-status
router.post('/smartlead/set-status', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { status } = req.body;
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    return res.status(400).json({ error: 'status must be ACTIVE or PAUSED' });
  }
  const slStatus = status === 'ACTIVE' ? 'START' : 'PAUSED';

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, smartlead_campaign_id')
    .not('smartlead_campaign_id', 'is', null)
    .neq('smartlead_campaign_id', 'syncing');

  const results = { updated: 0, errors: [] };
  for (const c of campaigns || []) {
    const ok = await updateCampaignStatus(parseInt(c.smartlead_campaign_id), slStatus);
    if (ok) results.updated++;
    else results.errors.push(c.smartlead_campaign_id);
  }

  console.log(`[admin/set-status] Set ${results.updated} campaigns to ${status}`);
  res.json(results);
});

// PATCH /api/admin/users/:auth_id/super-admin
router.patch('/users/:auth_id/super-admin', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { auth_id } = req.params;
  const { is_super_admin } = req.body;
  if (typeof is_super_admin !== 'boolean') {
    return res.status(400).json({ error: 'is_super_admin boolean required' });
  }

  // Update all user_details rows for this auth user
  const { error } = await supabase
    .from('user_details').update({ is_super_admin }).eq('auth_id', auth_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ auth_id, is_super_admin });
});

export default router;
