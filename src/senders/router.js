import express from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { updateEmailAccount } from '../config/smartlead.js';
import { requireUser, isAccountMember } from '../lib/auth.js';

const router = express.Router();

// Every column except smtp_password — the password is write-only through this API.
const SAFE_COLUMNS = 'id, account_id, email, display_name, provider, verified, verification_error, created_at, smtp_host, smtp_port, smtp_username, imap_host, imap_port, smartlead_email_account_id';

// Changing any of these means the stored credentials need re-verifying.
const CONNECTION_FIELDS = ['email', 'smtp_username', 'smtp_password', 'smtp_host', 'smtp_port', 'imap_host', 'imap_port'];

router.use(requireUser);

/**
 * POST /
 * Create a sender on an account the caller belongs to.
 */
router.post('/', async (req, res) => {
  const { account_id, email, display_name, smtp_password, smtp_host, smtp_port, imap_host, imap_port } = req.body;

  if (!account_id || !email?.trim() || !smtp_host?.trim() || !smtp_password?.trim()) {
    return res.status(400).json({ error: 'account_id, email, smtp_host and smtp_password required' });
  }
  if (!(await isAccountMember(req.authUser.id, account_id))) {
    return res.status(403).json({ error: 'Not a member of this account' });
  }

  const normalisedEmail = email.trim().toLowerCase();
  const { data: sender, error } = await getSupabaseAdmin()
    .from('senders')
    .insert({
      account_id,
      email:         normalisedEmail,
      display_name:  display_name?.trim() || null,
      smtp_host:     smtp_host.trim(),
      smtp_port:     parseInt(smtp_port) || 587,
      smtp_username: normalisedEmail,
      smtp_password: smtp_password.trim(),
      imap_host:     imap_host?.trim() || null,
      imap_port:     parseInt(imap_port) || 993,
      provider:      'smartlead',
      verified:      false,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ sender });
});

/**
 * PUT /:senderId/credentials
 * Update a sender's details and/or SMTP credentials. Connection changes reset verification state.
 * If the sender already has a Smartlead account, propagates the update there too.
 */
router.put('/:senderId/credentials', async (req, res) => {
  const { senderId } = req.params;
  const { email, display_name, smtp_username, smtp_password, smtp_host, smtp_port, imap_host, imap_port } = req.body;

  if (!senderId) return res.status(400).json({ error: 'senderId required' });

  const admin = getSupabaseAdmin();
  const { data: sender } = await admin.from('senders').select('*').eq('id', senderId).single();
  if (!sender || !(await isAccountMember(req.authUser.id, sender.account_id))) {
    return res.status(404).json({ error: 'Sender not found' });
  }

  // Pointing a sender at a different server without re-entering the password would
  // hand the stored password to that server on the next connection attempt.
  const hostChanged =
    (smtp_host && smtp_host.trim() !== sender.smtp_host) ||
    (imap_host !== undefined && (imap_host?.trim() || null) !== sender.imap_host);
  if (hostChanged && !smtp_password) {
    return res.status(400).json({ error: 'Re-enter the password to change the SMTP or IMAP host' });
  }

  const updates = {};
  if (email)               { updates.email = email.trim().toLowerCase(); updates.smtp_username = email.trim().toLowerCase(); }
  if (smtp_username?.trim()) updates.smtp_username = smtp_username.trim();
  if (display_name !== undefined) updates.display_name = display_name?.trim() || null;
  if (smtp_password)       updates.smtp_password = smtp_password;
  if (smtp_host)           updates.smtp_host = smtp_host.trim();
  if (smtp_port)           updates.smtp_port = parseInt(smtp_port) || 587;
  if (imap_host !== undefined) updates.imap_host = imap_host?.trim() || null;
  if (imap_port)           updates.imap_port = parseInt(imap_port) || 993;

  const connectionChanged = CONNECTION_FIELDS.some(f => f in updates && updates[f] !== sender[f]);
  if (connectionChanged) {
    updates.verified = false;
    updates.verification_error = null;
  }

  const { data: updated, error } = await admin.from('senders').update(updates).eq('id', senderId).select(SAFE_COLUMNS).single();
  if (error) return res.status(500).json({ error: error.message });

  if (sender.smartlead_email_account_id && (connectionChanged || 'display_name' in updates)) {
    try {
      await updateEmailAccount(sender.smartlead_email_account_id, {
        from_name:     updates.display_name ?? sender.display_name ?? updated.email,
        smtp_password: updates.smtp_password,
        smtp_host:     updates.smtp_host,
        smtp_port:     updates.smtp_port,
        imap_host:     updates.imap_host,
        imap_port:     updates.imap_port,
      });
    } catch (err) {
      console.warn(`[senders] Failed to update Smartlead account for sender ${senderId}:`, err.message);
    }
  }

  res.json({ sender: updated });
});

export default router;
