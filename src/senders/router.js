import express from 'express';
import nodemailer from 'nodemailer';
import { getSupabaseAdmin } from '../config/supabase.js';

const router = express.Router();

// POST /api/senders/:senderId/verify
// Tests the SMTP credentials for a sender and writes the result back to the row.
// Returns: { verified: true } | { verified: false, error: string }
router.post('/:senderId/verify', async (req, res) => {
  const { senderId } = req.params;
  const admin = getSupabaseAdmin();

  const { data: sender, error: fetchError } = await admin
    .from('senders').select('*').eq('id', senderId).single();

  if (fetchError || !sender) {
    return res.status(404).json({ error: 'Sender not found' });
  }

  if (!sender.smtp_host || !sender.smtp_password) {
    return res.status(400).json({ error: 'Sender is missing SMTP credentials' });
  }

  const transport = nodemailer.createTransport({
    host: sender.smtp_host,
    port: sender.smtp_port ?? 587,
    secure: (sender.smtp_port ?? 587) === 465,
    auth: {
      user: sender.smtp_username ?? sender.email,
      pass: sender.smtp_password,
    },
    family: 4,              // force IPv4 — Railway has no outbound IPv6
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout:    10_000,
  });

  try {
    await transport.verify();
    await admin
      .from('senders')
      .update({ verified: true, verification_error: null })
      .eq('id', senderId);
    console.log(`[senders] Verified SMTP for ${sender.email}`);
    return res.json({ verified: true });
  } catch (err) {
    const message = friendlySmtpError(err.message ?? String(err));
    await admin
      .from('senders')
      .update({ verified: false, verification_error: message })
      .eq('id', senderId);
    console.warn(`[senders] SMTP verification failed for ${sender.email}: ${message}`);
    return res.json({ verified: false, error: message });
  } finally {
    transport.close();
  }
});

// PUT /api/senders/:senderId/credentials
// Updates SMTP/IMAP credentials on an existing sender row (used by the retry flow).
router.put('/:senderId/credentials', async (req, res) => {
  const { senderId } = req.params;
  const { smtp_host, smtp_port, smtp_password, imap_host, imap_port } = req.body;
  const admin = getSupabaseAdmin();

  const { error } = await admin
    .from('senders')
    .update({
      smtp_host:     smtp_host     ?? undefined,
      smtp_port:     smtp_port     ?? undefined,
      smtp_password: smtp_password ?? undefined,
      imap_host:     imap_host     ?? undefined,
      imap_port:     imap_port     ?? undefined,
      verified:      false,
      verification_error: null,
    })
    .eq('id', senderId);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

/**
 * Map raw nodemailer/SMTP error strings to user-friendly messages.
 */
function friendlySmtpError(raw) {
  const msg = raw.toLowerCase();
  if (msg.includes('enotfound'))                         return 'SMTP host not found — double-check the server address';
  if (msg.includes('econnrefused'))                      return 'Connection refused — check the port number (try 587 or 465)';
  if (msg.includes('etimedout') || msg.includes('timeout')) return 'Connection timed out — check the host and port, and that your network allows outbound SMTP';
  if (msg.includes('self-signed') || msg.includes('certificate')) return 'SSL certificate error — try port 587 instead of 465';
  if (msg.includes('535') || msg.includes('534') || msg.includes('authentication failed') || msg.includes('invalid credentials')) return 'Authentication failed — check your password. For Gmail/Outlook you need an app password, not your regular password';
  if (msg.includes('530') || msg.includes('must issue a starttls')) return 'This server requires STARTTLS — use port 587';
  if (msg.includes('550') || msg.includes('relay'))     return 'Relay not permitted — your provider may not allow sending via SMTP from this address';
  return raw;
}

export default router;
