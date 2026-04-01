// -------------------------------------------------------------------------
// USER ROUTER
// Endpoints for multi-company support — listing and creating company
// workspaces for a single auth user.
// -------------------------------------------------------------------------

import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';

const router = Router();

// POST /api/user/companies — list all user_details for an auth user, joined with account
router.post('/companies', async (req, res) => {
  try {
    const { auth_id } = req.body;
    if (!auth_id) return res.status(400).json({ error: 'auth_id required' });

    const { data: rows, error } = await getSupabaseAdmin()
      .from('user_details')
      .select('id, firstname, signup_complete, active_mobilisation, active_step_id, account_id')
      .eq('auth_id', auth_id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    if (!rows || rows.length === 0) return res.json({ companies: [] });

    // Fetch account names for all distinct account_ids
    const accountIds = [...new Set(rows.map(r => r.account_id).filter(Boolean))];
    const { data: accounts } = await getSupabaseAdmin()
      .from('account')
      .select('id, organisation_name, organisation_website')
      .in('id', accountIds);

    const accountMap = Object.fromEntries((accounts ?? []).map(a => [a.id, a]));

    const companies = rows.map(r => ({
      ...r,
      account_name: accountMap[r.account_id]?.organisation_name ?? null,
      website: accountMap[r.account_id]?.organisation_website ?? null,
    }));

    res.json({ companies });
  } catch (err) {
    console.error('[user/companies]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/companies/create — create a new user_details + account for the same auth user
router.post('/companies/create', async (req, res) => {
  try {
    const { auth_id } = req.body;
    if (!auth_id) return res.status(400).json({ error: 'auth_id required' });

    const { data: account, error: ae } = await getSupabaseAdmin()
      .from('account')
      .insert({})
      .select()
      .single();
    if (ae) return res.status(500).json({ error: ae.message });

    const { firstname } = req.body;

    const { data: ud, error: ude } = await getSupabaseAdmin()
      .from('user_details')
      .insert({ auth_id, account_id: account.id, firstname: firstname ?? null })
      .select('id, firstname, signup_complete, active_mobilisation, active_step_id, account_id')
      .single();
    if (ude) return res.status(500).json({ error: ude.message });

    res.json({
      user_details_id: ud.id,
      account_id: account.id,
      company: {
        ...ud,
        account_name: null,
        website: null,
      },
    });
  } catch (err) {
    console.error('[user/companies/create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/companies/delete — delete a company workspace and all its data
router.post('/companies/delete', async (req, res) => {
  try {
    const { user_details_id, auth_id } = req.body;
    if (!user_details_id || !auth_id) return res.status(400).json({ error: 'user_details_id and auth_id required' });

    const supabase = getSupabaseAdmin();

    // Guard: don't allow deleting the last company
    const { count } = await supabase
      .from('user_details')
      .select('id', { count: 'exact', head: true })
      .eq('auth_id', auth_id);
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete your only company' });

    // Get the account_id for this user_details row
    const { data: ud } = await supabase
      .from('user_details')
      .select('account_id')
      .eq('id', user_details_id)
      .single();
    if (!ud) return res.status(404).json({ error: 'Company not found' });

    const accountId = ud.account_id;

    // Delete in dependency order
    await supabase.from('messages').delete().eq('user_details_id', user_details_id);

    if (accountId) {
      // Get ITP IDs to delete leads
      const { data: itps } = await supabase.from('itp').select('id').eq('account_id', accountId);
      const itpIds = (itps ?? []).map(i => i.id);
      if (itpIds.length > 0) {
        await supabase.from('leads').delete().in('itp_id', itpIds);
      }

      await supabase.from('itp').delete().eq('account_id', accountId);
      await supabase.from('campaigns').delete().eq('account_id', accountId);
      await supabase.from('customers').delete().eq('account_id', accountId);
      await supabase.from('senders').delete().eq('account_id', accountId);
    }

    await supabase.from('user_details').delete().eq('id', user_details_id);

    if (accountId) {
      await supabase.from('account').delete().eq('id', accountId);
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('[user/companies/delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
