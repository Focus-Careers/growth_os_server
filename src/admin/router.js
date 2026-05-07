import express from 'express';
import cron from 'node-cron';
import { getSupabaseAdmin } from '../config/supabase.js';
import { dispatchSkill } from '../employees/index.js';
import { addJob, removeJob, pauseJob, resumeJob } from './cronService.js';

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

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalLeads },
    { data: leadScores },
    { count: totalCampaignContacts },
    { count: totalCampaigns },
    { count: totalCompanies },
    { count: leadsThisWeek },
    { count: contactsThisWeek },
    { data: recentRuns },
    { data: accounts },
  ] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }),
    supabase.from('leads').select('score').not('score', 'is', null),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('account').select('*', { count: 'exact', head: true }),
    supabase.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
    supabase.from('lead_generation_runs')
      .select('id, campaign_id, status, estimated_cost_pence, created_at, campaigns(name, account_id, account(organisation_name))')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('account')
      .select('id, organisation_name, campaigns(id, name, status, itp_id)'),
  ]);

  const avgScore = leadScores?.length
    ? Math.round(leadScores.reduce((sum, l) => sum + (l.score || 0), 0) / leadScores.length)
    : 0;

  // Per-company lead + contact counts
  const accountIds = (accounts || []).map(a => a.id);
  const perCompany = await Promise.all(accountIds.map(async (account_id) => {
    const account = accounts.find(a => a.id === account_id);
    const campaignIds = (account.campaigns || []).map(c => c.id);
    if (campaignIds.length === 0) return { account_id, account_name: account.organisation_name, campaigns: account.campaigns, leadCount: 0, contactCount: 0 };

    const itpIds = [...new Set((account.campaigns || []).map(c => c.itp_id).filter(Boolean))];
    const [{ count: leadCount }, { count: contactCount }] = await Promise.all([
      supabase.from('leads').select('*', { count: 'exact', head: true }).in('itp_id', itpIds),
      supabase.from('campaign_contacts').select('*', { count: 'exact', head: true }).in('campaign_id', campaignIds),
    ]);
    return { account_id, account_name: account.organisation_name, campaigns: account.campaigns, leadCount: leadCount ?? 0, contactCount: contactCount ?? 0 };
  }));

  res.json({
    aggregated: { totalLeads, avgScore, totalCampaignContacts, totalCampaigns, totalCompanies, leadsThisWeek, contactsThisWeek },
    recentRuns: recentRuns || [],
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

  // Resolve campaign names
  const allCampaignIds = [...new Set((crons || []).flatMap(c => c.campaign_ids))];
  let campaignNames = {};
  if (allCampaignIds.length > 0) {
    const { data: camps } = await supabase
      .from('campaigns')
      .select('id, name, account:account(organisation_name)')
      .in('id', allCampaignIds);
    (camps || []).forEach(c => { campaignNames[c.id] = { name: c.name, company: c.account?.organisation_name }; });
  }

  const enriched = (crons || []).map(c => ({
    ...c,
    campaigns: c.campaign_ids.map(id => ({ id, ...( campaignNames[id] || { name: 'Unknown', company: '' }) })),
  }));

  res.json({ crons: enriched });
});

// POST /api/admin/crons
router.post('/crons', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { user_details_id, label, campaign_ids, cron_expression } = req.body;
  if (!label || !Array.isArray(campaign_ids) || campaign_ids.length === 0 || !cron_expression) {
    return res.status(400).json({ error: 'label, campaign_ids, and cron_expression required' });
  }
  if (!cron.validate(cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const { data, error } = await supabase
    .from('target_finder_crons')
    .insert({ label, campaign_ids, cron_expression, created_by: user_details_id, active: true })
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

  let connected = false;
  try {
    const pingRes = await fetch(`https://server.smartlead.ai/api/v1/campaigns?limit=1&offset=0`, {
      headers: { 'X-API-KEY': process.env.SMARTLEAD_API_KEY },
    });
    connected = pingRes.ok;
  } catch {
    connected = false;
  }

  res.json({ sync_enabled: config?.sync_enabled ?? true, connected, updated_at: config?.updated_at });
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
    .select('id, firstname, role, is_super_admin, account_id, account:account(organisation_name)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Get emails from auth.users via admin API
  const { data: { users: authUsers } } = await supabase.auth.admin.listUsers();
  const emailMap = {};
  (authUsers || []).forEach(u => { emailMap[u.id] = u.email; });

  // Join auth email — user_details.auth_id links to auth.users.id
  const { data: withAuth } = await supabase
    .from('user_details').select('id, auth_id');
  const authIdMap = {};
  (withAuth || []).forEach(u => { authIdMap[u.id] = u.auth_id; });

  const enriched = (users || []).map(u => ({
    ...u,
    email: emailMap[authIdMap[u.id]] ?? null,
  }));

  res.json({ users: enriched });
});

// PATCH /api/admin/users/:id/super-admin
router.patch('/users/:id/super-admin', async (req, res) => {
  const supabase = await requireSuperAdmin(req, res);
  if (!supabase) return;

  const { id } = req.params;
  const { is_super_admin } = req.body;
  if (typeof is_super_admin !== 'boolean') {
    return res.status(400).json({ error: 'is_super_admin boolean required' });
  }

  const { data, error } = await supabase
    .from('user_details').update({ is_super_admin }).eq('id', id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

export default router;
