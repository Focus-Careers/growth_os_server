// -------------------------------------------------------------------------
// USER ROUTER
// Endpoints for multi-company and multi-user support.
// -------------------------------------------------------------------------

import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

// ── Login ─────────────────────────────────────────────────────────────────

// POST /api/user/login — generate a magic link for an existing user (no email sent)
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const supabase = getSupabaseAdmin();
    const normEmail = email.toLowerCase().trim();

    // Step 1: Find the auth user by email (direct query to auth.users via service role)
    const { data: authUser } = await supabase
      .schema('auth').from('users').select('id').eq('email', normEmail).maybeSingle();

    // Step 2: If not in auth.users, paginate listUsers as fallback
    let authUserId = authUser?.id ?? null;
    if (!authUserId) {
      let page = 1;
      outer: while (true) {
        const { data: { users } = {} } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
        if (!users?.length) break;
        for (const u of users) {
          if (u.email === normEmail) { authUserId = u.id; break outer; }
        }
        if (users.length < 100) break;
        page++;
      }
    }

    if (!authUserId) return res.status(404).json({ error: 'No account found with this email.' });

    // Step 3: Confirm they have a user_details record (i.e. completed signup)
    const { data: rows } = await supabase
      .from('user_details').select('id').eq('auth_id', authUserId).limit(1);
    if (!rows?.length) return res.status(404).json({ error: 'No account found with this email.' });

    // Step 4: Generate magic link for the known-good auth user
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: normEmail,
      options: { redirectTo: APP_URL },
    });
    if (linkError) return res.status(500).json({ error: linkError.message });

    res.json({ login_url: linkData.properties.action_link });
  } catch (err) {
    console.error('[user/login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Companies ─────────────────────────────────────────────────────────────

// POST /api/user/companies — list all user_details for an auth user, joined with account
router.post('/companies', async (req, res) => {
  try {
    const { auth_id } = req.body;
    if (!auth_id) return res.status(400).json({ error: 'auth_id required' });

    const { data: rows, error } = await getSupabaseAdmin()
      .from('user_details')
      .select('id, firstname, signup_complete, active_mobilisation, active_step_id, account_id, role, is_super_admin')
      .eq('auth_id', auth_id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    if (!rows || rows.length === 0) return res.json({ companies: [] });

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
    const { auth_id, firstname } = req.body;
    if (!auth_id) return res.status(400).json({ error: 'auth_id required' });

    const { data: account, error: ae } = await getSupabaseAdmin()
      .from('account')
      .insert({})
      .select()
      .single();
    if (ae) return res.status(500).json({ error: ae.message });

    const { data: ud, error: ude } = await getSupabaseAdmin()
      .from('user_details')
      .insert({ auth_id, account_id: account.id, firstname: firstname ?? null, role: 'admin' })
      .select('id, firstname, signup_complete, active_mobilisation, active_step_id, account_id, role')
      .single();
    if (ude) return res.status(500).json({ error: ude.message });

    res.json({
      user_details_id: ud.id,
      account_id: account.id,
      company: { ...ud, account_name: null, website: null },
    });
  } catch (err) {
    console.error('[user/companies/create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/companies/delete — delete a company workspace and all its data (admin only)
router.post('/companies/delete', async (req, res) => {
  try {
    const { user_details_id, auth_id } = req.body;
    if (!user_details_id || !auth_id) return res.status(400).json({ error: 'user_details_id and auth_id required' });

    const supabase = getSupabaseAdmin();

    // Guard: admin only
    const { data: requester } = await supabase
      .from('user_details').select('role, account_id').eq('id', user_details_id).single();
    if (requester?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    // Guard: can't delete last company
    const { count } = await supabase
      .from('user_details').select('id', { count: 'exact', head: true }).eq('auth_id', auth_id);
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete your only company' });

    const accountId = requester.account_id;

    // Delete all user_details for this account (and their messages)
    const { data: allMembers } = await supabase
      .from('user_details').select('id').eq('account_id', accountId);
    for (const m of allMembers ?? []) {
      await supabase.from('messages').delete().eq('user_details_id', m.id);
    }

    if (accountId) {
      const { data: itps } = await supabase.from('itp').select('id').eq('account_id', accountId);
      const itpIds = (itps ?? []).map(i => i.id);
      if (itpIds.length > 0) await supabase.from('leads').delete().in('itp_id', itpIds);
      await supabase.from('itp').delete().eq('account_id', accountId);
      await supabase.from('campaigns').delete().eq('account_id', accountId);
      await supabase.from('customers').delete().eq('account_id', accountId);
      await supabase.from('senders').delete().eq('account_id', accountId);
      await supabase.from('invites').delete().eq('account_id', accountId);
    }

    await supabase.from('user_details').delete().eq('account_id', accountId);
    if (accountId) await supabase.from('account').delete().eq('id', accountId);

    res.json({ deleted: true });
  } catch (err) {
    console.error('[user/companies/delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Members ───────────────────────────────────────────────────────────────

// POST /api/user/members — list all members for an account
router.post('/members', async (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });

    const { data: members, error } = await getSupabaseAdmin()
      .from('user_details')
      .select('id, auth_id, firstname, role')
      .eq('account_id', account_id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Fetch emails from auth
    const enriched = await Promise.all((members ?? []).map(async m => {
      const { data: authUser } = await getSupabaseAdmin().auth.admin.getUserById(m.auth_id);
      return { ...m, email: authUser?.user?.email ?? null };
    }));

    res.json({ members: enriched });
  } catch (err) {
    console.error('[user/members]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/members/update-role — promote or demote a member (admin only)
router.post('/members/update-role', async (req, res) => {
  try {
    const { user_details_id, target_user_details_id, new_role } = req.body;
    if (!user_details_id || !target_user_details_id || !new_role) {
      return res.status(400).json({ error: 'user_details_id, target_user_details_id, new_role required' });
    }
    if (!['admin', 'member'].includes(new_role)) return res.status(400).json({ error: 'Invalid role' });

    const supabase = getSupabaseAdmin();
    const { data: requester } = await supabase
      .from('user_details').select('role, account_id').eq('id', user_details_id).single();
    if (requester?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    // Guard: can't demote yourself
    if (user_details_id === target_user_details_id && new_role === 'member') {
      return res.status(400).json({ error: 'You cannot demote yourself' });
    }

    // Guard: can't demote the last admin
    if (new_role === 'member') {
      const { count } = await supabase
        .from('user_details')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', requester.account_id)
        .eq('role', 'admin');
      if (count <= 1) return res.status(400).json({ error: 'Cannot demote the last admin' });
    }

    await supabase.from('user_details').update({ role: new_role }).eq('id', target_user_details_id);
    res.json({ updated: true });
  } catch (err) {
    console.error('[user/members/update-role]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/members/remove — remove a member (admin only)
router.post('/members/remove', async (req, res) => {
  try {
    const { user_details_id, target_user_details_id } = req.body;
    if (!user_details_id || !target_user_details_id) {
      return res.status(400).json({ error: 'user_details_id and target_user_details_id required' });
    }

    const supabase = getSupabaseAdmin();
    const { data: requester } = await supabase
      .from('user_details').select('role, account_id').eq('id', user_details_id).single();
    if (requester?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    // Can't remove yourself
    if (user_details_id === target_user_details_id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    await supabase.from('messages').delete().eq('user_details_id', target_user_details_id);
    await supabase.from('user_details').delete().eq('id', target_user_details_id);
    res.json({ removed: true });
  } catch (err) {
    console.error('[user/members/remove]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Invites ───────────────────────────────────────────────────────────────

// POST /api/user/invite/generate — create a single-use invite link (admin only)
router.post('/invite/generate', async (req, res) => {
  try {
    const { user_details_id } = req.body;
    if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });

    const supabase = getSupabaseAdmin();
    const { data: requester } = await supabase
      .from('user_details').select('role, account_id').eq('id', user_details_id).single();
    if (requester?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { data: invite, error } = await supabase
      .from('invites')
      .insert({ account_id: requester.account_id, invited_by: user_details_id })
      .select('token, expires_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const link = `${APP_URL}?invite=${invite.token}`;
    res.json({ link, expires_at: invite.expires_at });
  } catch (err) {
    console.error('[user/invite/generate]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/invite/accept — accept an invite token
router.post('/invite/accept', async (req, res) => {
  try {
    const { token, auth_id } = req.body;
    if (!token || !auth_id) return res.status(400).json({ error: 'token and auth_id required' });

    const supabase = getSupabaseAdmin();

    // Validate token
    const { data: invite, error: ie } = await supabase
      .from('invites')
      .select('id, account_id, status, expires_at, invited_by')
      .eq('token', token)
      .single();

    if (ie || !invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'Invite already used or expired' });
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from('invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(400).json({ error: 'Invite has expired' });
    }

    // Fetch inviter name for the landing screen
    const { data: inviter } = invite.invited_by
      ? await supabase.from('user_details').select('firstname').eq('id', invite.invited_by).single()
      : { data: null };
    const inviter_firstname = inviter?.firstname ?? null;

    // Check if already a member
    const { data: existing } = await supabase
      .from('user_details')
      .select('id, account_id, role')
      .eq('auth_id', auth_id)
      .eq('account_id', invite.account_id)
      .single();

    if (existing) {
      await supabase.from('invites').update({ status: 'accepted' }).eq('id', invite.id);
      const { data: account } = await supabase
        .from('account').select('organisation_name, organisation_website').eq('id', invite.account_id).single();
      return res.json({
        already_member: true,
        user_details_id: existing.id,
        account_id: invite.account_id,
        account_name: account?.organisation_name ?? null,
        website: account?.organisation_website ?? null,
        role: existing.role,
        inviter_firstname,
      });
    }

    // Firstname: prefer existing user_details row (already-logged-in user),
    // fall back to auth metadata (brand-new user invited via InviteSignup).
    // Email is intentionally excluded — user_details.email has a UNIQUE constraint
    // and the email already lives in auth.users tied via auth_id.
    const { data: authUser } = await supabase.auth.admin.getUserById(auth_id);
    const { data: existingUd } = await supabase
      .from('user_details').select('firstname').eq('auth_id', auth_id).limit(1).single();
    const firstname = existingUd?.firstname ?? authUser?.user?.user_metadata?.firstname ?? null;

    // Create user_details for the invitee on the shared account
    const { data: newUd, error: ude } = await supabase
      .from('user_details')
      .insert({
        auth_id,
        account_id: invite.account_id,
        signup_complete: true,
        role: 'member',
        firstname,
      })
      .select('id, account_id, role, firstname')
      .single();

    if (ude) return res.status(500).json({ error: ude.message });

    // Mark invite accepted (single-use)
    await supabase.from('invites').update({ status: 'accepted' }).eq('id', invite.id);

    const { data: account } = await supabase
      .from('account').select('organisation_name, organisation_website').eq('id', invite.account_id).single();

    res.json({
      user_details_id: newUd.id,
      account_id: invite.account_id,
      account_name: account?.organisation_name ?? null,
      website: account?.organisation_website ?? null,
      role: newUd.role,
      firstname: newUd.firstname,
      inviter_firstname,
    });
  } catch (err) {
    console.error('[user/invite/accept]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/invite/preview — unauthenticated; validates token and returns account name
// Used by the InviteSignup screen to show "You've been invited to join X" before auth
router.post('/invite/preview', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const supabase = getSupabaseAdmin();
    const { data: invite } = await supabase
      .from('invites')
      .select('id, account_id, status, expires_at')
      .eq('token', token)
      .single();

    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used.' });
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from('invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(400).json({ error: 'This invite has expired.' });
    }

    const { data: account } = await supabase
      .from('account').select('organisation_name').eq('id', invite.account_id).single();

    res.json({ account_name: account?.organisation_name ?? null, expires_at: invite.expires_at });
  } catch (err) {
    console.error('[user/invite/preview]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/user/invite/create-auth-user — creates a Supabase auth user for a new invitee
// Does NOT create account or user_details — that happens at invite/accept after login
router.post('/invite/create-auth-user', async (req, res) => {
  try {
    const { token, firstname, email } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'token and email required' });

    const supabase = getSupabaseAdmin();

    // Validate token is still usable
    const { data: invite } = await supabase
      .from('invites').select('id, status, expires_at').eq('token', token).single();
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used.' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired.' });

    // Create auth user only (firstname stored in metadata for use at invite/accept)
    // If the email is already registered, createUser returns an error we surface as user_exists
    const { error: createError } = await supabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      user_metadata: { firstname: firstname?.trim() ?? '' },
      email_confirm: true,
    });
    if (createError) {
      if (createError.message?.toLowerCase().includes('already registered') || createError.code === 'email_exists') {
        return res.status(409).json({ error: 'user_exists' });
      }
      return res.status(500).json({ error: createError.message });
    }

    // Generate magic link — user clicks it to log in, invite token processes on return
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: email.toLowerCase().trim(),
      options: { redirectTo: process.env.APP_URL },
    });
    if (linkError) return res.status(500).json({ error: linkError.message });

    res.json({ login_url: linkData.properties.action_link });
  } catch (err) {
    console.error('[user/invite/create-auth-user]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
