import { getSupabaseAdmin } from '../../../config/supabase.js';
import {
  getEmailAccounts,
  createEmailAccount,
} from '../../../config/smartlead.js';

/**
 * Resolves a sender to a Smartlead email account ID.
 * If the sender doesn't have one yet, checks Smartlead for an existing
 * account with the same email, or creates a new one.
 *
 * @param {string} senderId - The sender ID from our DB
 * @returns {{ slEmailAccountId: string|null, sender: object }}
 */
export async function resolveSmartleadSender(senderId) {
  const admin = getSupabaseAdmin();

  const { data: sender } = await admin
    .from('senders')
    .select('*')
    .eq('id', senderId)
    .single();

  if (!sender) {
    console.warn(`[resolveSmartleadSender] Sender not found: ${senderId}`);
    return { slEmailAccountId: null, sender: null };
  }

  let slEmailAccountId = sender.smartlead_email_account_id;

  if (!slEmailAccountId) {
    // Check if this email already exists in Smartlead
    const existingAccounts = await getEmailAccounts();
    const existing = existingAccounts.find(a => a.from_email === sender.email);

    if (existing) {
      slEmailAccountId = String(existing.id);
    } else if (sender.smtp_host && sender.smtp_password) {
      // Create new email account in Smartlead
      const newAccount = await createEmailAccount({
        from_name: sender.display_name ?? sender.email,
        from_email: sender.email,
        smtp_host: sender.smtp_host,
        smtp_port: sender.smtp_port ?? 587,
        smtp_username: sender.smtp_username ?? sender.email,
        smtp_password: sender.smtp_password,
        imap_host: sender.imap_host,
        imap_port: sender.imap_port ?? 993,
        max_email_per_day: 50,
      });
      if (newAccount?.id) {
        slEmailAccountId = String(newAccount.id);
      }
    } else {
      console.warn('[resolveSmartleadSender] Sender has no SMTP details, skipping email account setup');
    }

    // Save Smartlead email account ID to our DB
    if (slEmailAccountId) {
      await admin.from('senders')
        .update({ smartlead_email_account_id: slEmailAccountId })
        .eq('id', sender.id);
    }
  }

  return { slEmailAccountId, sender };
}
