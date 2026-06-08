// -----------------------------------------------------------------------------
// PROVISIONING POLLER
// Polls SmartSenders every 30 minutes for orders in ORDER_PLACED / PROVISIONING.
// On completion, creates senders rows + transitions order to ACTIVE.
// -----------------------------------------------------------------------------

import cron from 'node-cron';
import { getSupabaseAdmin } from '../config/supabase.js';
import { getOrderStatus } from '../config/smartsenders.js';
import { createEmailAccount, getEmailAccounts } from '../config/smartlead.js';

const POLL_SCHEDULE = '*/30 * * * *'; // every 30 min
const STALL_MS = 48 * 60 * 60 * 1000; // 48h → PROVISIONING_STALLED

export function initProvisioningPoller() {
  cron.schedule(POLL_SCHEDULE, () => {
    pollOnce().catch(err => console.error('[provisioning/poller] tick error:', err));
  });
  console.log(`[provisioning/poller] Started (${POLL_SCHEDULE})`);

  // Kick a poll on startup so restarts don't waste a cycle
  setTimeout(() => {
    pollOnce().catch(err => console.error('[provisioning/poller] startup poll error:', err));
  }, 5_000);
}

export async function pollOnce() {
  const admin = getSupabaseAdmin();
  const { data: orders, error } = await admin
    .from('provisioning_orders')
    .select('*')
    .in('state', ['ORDER_PLACED', 'PROVISIONING']);

  if (error) {
    console.error('[provisioning/poller] fetch error:', error.message);
    return { polled: 0 };
  }
  if (!orders?.length) return { polled: 0 };

  console.log(`[provisioning/poller] Polling ${orders.length} order(s)`);
  let advanced = 0;
  for (const order of orders) {
    try {
      const moved = await processOrder(order, admin);
      if (moved) advanced++;
    } catch (err) {
      console.error(`[provisioning/poller] order ${order.id}:`, err);
    }
  }
  return { polled: orders.length, advanced };
}

async function processOrder(order, admin) {
  if (!order.smartsenders_order_id) {
    // Order placement failed before we got an id — mark failed
    await admin.from('provisioning_orders').update({
      state: 'ORDER_FAILED',
      last_error: 'No SmartSenders order_id recorded',
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    return true;
  }

  // Stall check
  const age = Date.now() - new Date(order.created_at).getTime();
  if (age > STALL_MS) {
    await admin.from('provisioning_orders').update({
      state: 'PROVISIONING_STALLED',
      last_error: `No completion after ${Math.round(age / 3600000)}h`,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    console.warn(`[provisioning/poller] Order ${order.id} stalled after ${Math.round(age / 3600000)}h`);
    return true;
  }

  const { ok, raw, status } = await getOrderStatus(order.smartsenders_order_id);
  const nowIso = new Date().toISOString();

  if (!ok) {
    await admin.from('provisioning_orders').update({
      last_poll_at: nowIso,
      last_error: `Poll HTTP ${status}`,
      updated_at: nowIso,
    }).eq('id', order.id);
    return false;
  }

  const stateRaw = (raw?.status ?? raw?.state ?? raw?.order_status ?? '').toLowerCase();
  const completed = ['completed', 'complete', 'done', 'active', 'finished'].includes(stateRaw);
  const failed    = ['failed', 'cancelled', 'canceled', 'error'].includes(stateRaw);
  const processing = !completed && !failed;

  if (failed) {
    await admin.from('provisioning_orders').update({
      state: 'ORDER_FAILED',
      last_poll_at: nowIso,
      last_error: raw?.error ?? raw?.message ?? `Vendor reported: ${stateRaw}`,
      order_response: raw,
      updated_at: nowIso,
    }).eq('id', order.id);
    return true;
  }

  if (processing) {
    await admin.from('provisioning_orders').update({
      state: 'PROVISIONING',
      last_poll_at: nowIso,
      order_response: raw,
      updated_at: nowIso,
    }).eq('id', order.id);
    return false;
  }

  // Completed — create senders
  const mailboxes = raw?.mailboxes ?? raw?.email_accounts ?? raw?.data?.mailboxes ?? [];
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
    console.warn(`[provisioning/poller] Order ${order.id} reported complete but no mailboxes in payload`, raw);
    await admin.from('provisioning_orders').update({
      last_poll_at: nowIso,
      last_error: 'Completed without mailbox details',
      order_response: raw,
      updated_at: nowIso,
    }).eq('id', order.id);
    return false;
  }

  const senderIds = await createSendersFromMailboxes(order, mailboxes, admin);

  await admin.from('provisioning_orders').update({
    state: 'ACTIVE',
    last_poll_at: nowIso,
    completed_at: nowIso,
    warmup_started_at: nowIso,
    order_response: raw,
    updated_at: nowIso,
    last_error: null,
  }).eq('id', order.id);

  console.log(`[provisioning/poller] Order ${order.id} → ACTIVE (${senderIds.length} senders created)`);
  return true;
}

async function createSendersFromMailboxes(order, mailboxes, admin) {
  const created = [];
  // Pre-fetch existing Smartlead accounts once to avoid N round-trips when filling in IDs
  let existingAccounts = null;
  const ensureExisting = async () => {
    if (existingAccounts === null) existingAccounts = await getEmailAccounts();
    return existingAccounts;
  };

  for (const mb of mailboxes) {
    const email = (mb.email ?? mb.from_email ?? mb.address ?? '').toLowerCase().trim();
    if (!email) {
      console.warn(`[provisioning/poller] Mailbox in order ${order.id} has no email, skipping:`, mb);
      continue;
    }

    // Skip duplicates within this account
    const { data: dup } = await admin
      .from('senders')
      .select('id')
      .eq('account_id', order.account_id)
      .eq('email', email)
      .maybeSingle();
    if (dup) {
      console.log(`[provisioning/poller] Sender ${email} already exists for account ${order.account_id}`);
      created.push(dup.id);
      continue;
    }

    // Determine Smartlead account id — prefer payload; fall back to creating via SMTP, then matching by email
    let slEmailAccountId = mb.smartlead_email_account_id ?? mb.email_account_id ?? null;

    const smtp = {
      smtp_host:     mb.smtp_host     ?? mb.smtp?.host     ?? null,
      smtp_port:     mb.smtp_port     ?? mb.smtp?.port     ?? 587,
      smtp_username: mb.smtp_username ?? mb.smtp?.username ?? email,
      smtp_password: mb.smtp_password ?? mb.smtp?.password ?? mb.password ?? null,
      imap_host:     mb.imap_host     ?? mb.imap?.host     ?? null,
      imap_port:     mb.imap_port     ?? mb.imap?.port     ?? 993,
    };

    if (!slEmailAccountId && smtp.smtp_host && smtp.smtp_password) {
      const newAcct = await createEmailAccount({
        from_name: `${mb.first_name ?? ''} ${mb.last_name ?? ''}`.trim() || email,
        from_email: email,
        smtp_host: smtp.smtp_host,
        smtp_port: smtp.smtp_port,
        smtp_username: smtp.smtp_username,
        smtp_password: smtp.smtp_password,
        imap_host: smtp.imap_host,
        imap_port: smtp.imap_port,
        max_email_per_day: 50,
      });
      if (newAcct?.id) slEmailAccountId = String(newAcct.id);
    }

    if (!slEmailAccountId) {
      const accounts = await ensureExisting();
      const match = accounts.find(a => (a.from_email ?? '').toLowerCase() === email);
      if (match) slEmailAccountId = String(match.id);
    }

    const { data: sender, error: senderErr } = await admin
      .from('senders')
      .insert({
        account_id: order.account_id,
        provisioning_order_id: order.id,
        connection_type: 'provisioned',
        email,
        display_name: `${mb.first_name ?? ''} ${mb.last_name ?? ''}`.trim() || null,
        provider: 'smartlead',
        verified: true,
        smtp_host: smtp.smtp_host,
        smtp_port: smtp.smtp_port,
        smtp_username: smtp.smtp_username,
        smtp_password: smtp.smtp_password,
        imap_host: smtp.imap_host,
        imap_port: smtp.imap_port,
        smartlead_email_account_id: slEmailAccountId,
        warmup_started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (senderErr) {
      console.error(`[provisioning/poller] Failed to insert sender ${email}:`, senderErr.message);
      continue;
    }
    created.push(sender.id);
  }
  return created;
}
