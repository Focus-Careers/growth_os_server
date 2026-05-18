import express from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { updateEmailAccount } from '../config/smartlead.js';

const router = express.Router();

/**
 * PUT /:senderId/credentials
 * Update SMTP credentials for a sender and reset verification state.
 * If the sender already has a Smartlead account, propagates the update there too.
 */
router.put('/:senderId/credentials', async (req, res) => {
  const { senderId } = req.params;
  const { email, display_name, smtp_password, smtp_host, smtp_port, imap_host, imap_port } = req.body;

  if (!senderId) return res.status(400).json({ error: 'senderId required' });

  const admin = getSupabaseAdmin();
  const { data: sender } = await admin.from('senders').select('*').eq('id', senderId).single();
  if (!sender) return res.status(404).json({ error: 'Sender not found' });

  const updates = { verified: false, verification_error: null };
  if (email)               { updates.email = email.trim().toLowerCase(); updates.smtp_username = email.trim().toLowerCase(); }
  if (display_name !== undefined) updates.display_name = display_name?.trim() || null;
  if (smtp_password)       updates.smtp_password = smtp_password;
  if (smtp_host)           updates.smtp_host = smtp_host.trim();
  if (smtp_port)           updates.smtp_port = parseInt(smtp_port) || 587;
  if (imap_host !== undefined) updates.imap_host = imap_host?.trim() || null;
  if (imap_port)           updates.imap_port = parseInt(imap_port) || 993;

  const { data: updated, error } = await admin.from('senders').update(updates).eq('id', senderId).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (sender.smartlead_email_account_id) {
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
