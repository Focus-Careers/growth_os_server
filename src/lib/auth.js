import { getSupabaseAdmin } from '../config/supabase.js';

/**
 * Express middleware: requires a valid Supabase access token in the
 * Authorization header and sets req.authUser to the signed-in auth user.
 */
export async function requireUser(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Not authenticated' });

  req.authUser = data.user;
  next();
}

/** True if the auth user has a user_details row on the given account. */
export async function isAccountMember(authId, accountId) {
  if (!authId || !accountId) return false;
  const { data } = await getSupabaseAdmin()
    .from('user_details')
    .select('id')
    .eq('auth_id', authId)
    .eq('account_id', accountId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}
