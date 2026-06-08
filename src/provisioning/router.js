// -----------------------------------------------------------------------------
// PROVISIONING ROUTER
// Endpoints for SmartSenders mailbox provisioning.
//   GET  /api/provisioning/vendors                     — list SmartSenders vendors
//   POST /api/provisioning/suggest-domains             — { primary_domain } → suggestions
//   POST /api/provisioning/place-order                 — kick off an order
//   GET  /api/provisioning/orders/:accountId           — list orders for an account
// -----------------------------------------------------------------------------

import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { getVendors, placeOrder, ping } from '../config/smartsenders.js';
import { suggestDomains } from '../utils/domain_suggestions.js';
import { pickPersonas } from '../utils/sender_personas.js';

const router = Router();

const TIERS = {
  basic:  { num_domains: 1,  num_mailboxes: 2  },
  growth: { num_domains: 3,  num_mailboxes: 6  },
  scale:  { num_domains: 10, num_mailboxes: 20 },
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendors
// ─────────────────────────────────────────────────────────────────────────────
router.get('/vendors', async (_req, res) => {
  try {
    const vendors = await getVendors();
    res.json({ vendors });
  } catch (err) {
    console.error('[provisioning/vendors]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — SmartSenders API key check
// ─────────────────────────────────────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  const { ok, status } = await ping();
  res.json({ connected: ok, http_status: status });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /suggest-domains  { primary_domain }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/suggest-domains', (req, res) => {
  const { primary_domain } = req.body ?? {};
  if (!primary_domain) {
    return res.status(400).json({ error: 'primary_domain required' });
  }
  const suggestions = suggestDomains(primary_domain, { count: 5 });
  res.json({ suggestions });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /place-order
//   {
//     account_id, tier ('basic'|'growth'|'scale'),
//     primary_domain, selected_domain,
//     vendor_id, pre_warmed?,
//     user_details: { first_name, last_name, email, phone, address?, city?, country?, postcode? }
//   }
// Creates a provisioning_orders row, calls SmartSenders place-order, returns the order.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/place-order', async (req, res) => {
  const {
    account_id,
    tier = 'basic',
    primary_domain,
    selected_domain,
    vendor_id,
    pre_warmed = false,
    user_details,
  } = req.body ?? {};

  if (!account_id)        return res.status(400).json({ error: 'account_id required' });
  if (!selected_domain)   return res.status(400).json({ error: 'selected_domain required' });
  if (!vendor_id)         return res.status(400).json({ error: 'vendor_id required' });
  if (!user_details?.first_name || !user_details?.last_name || !user_details?.email) {
    return res.status(400).json({ error: 'user_details (first_name, last_name, email) required' });
  }

  const tierConfig = TIERS[tier];
  if (!tierConfig) return res.status(400).json({ error: `unknown tier: ${tier}` });

  const admin = getSupabaseAdmin();

  // 1. Insert PENDING order row first — even if SmartSenders fails, we have an audit trail
  const { data: order, error: insertErr } = await admin
    .from('provisioning_orders')
    .insert({
      account_id,
      state: 'PENDING',
      tier,
      primary_domain,
      selected_domain,
      vendor_id,
      pre_warmed,
      num_domains: tierConfig.num_domains,
      num_mailboxes: tierConfig.num_mailboxes,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[provisioning/place-order] insert error:', insertErr);
    return res.status(500).json({ error: insertErr.message });
  }

  // 2. Build mailbox personas (seed by order id for stable selection)
  const mailboxes = pickPersonas(tierConfig.num_mailboxes, order.id);
  const forwarding_domain = primary_domain?.startsWith('http')
    ? primary_domain
    : `https://${primary_domain ?? selected_domain}`;

  // 3. Call SmartSenders
  const payload = {
    vendor_id,
    domain: selected_domain,
    forwarding_domain,
    mailboxes,
    user_details,
    pre_warmed,
  };
  const result = await placeOrder(payload);

  // 4. Update order row with response
  const updates = {
    order_payload: payload,
    order_response: result.raw,
    updated_at: new Date().toISOString(),
  };

  if (result.ok && result.order_id) {
    updates.smartsenders_order_id = result.order_id;
    updates.state = 'ORDER_PLACED';
  } else {
    updates.state = 'ORDER_FAILED';
    updates.last_error = result.raw?.message ?? result.raw?.error ?? `HTTP ${result.status}`;
  }

  const { data: updated } = await admin
    .from('provisioning_orders')
    .update(updates)
    .eq('id', order.id)
    .select()
    .single();

  if (!result.ok) {
    return res.status(502).json({ error: 'SmartSenders order failed', order: updated });
  }

  res.json({ order: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /orders/:accountId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/orders/:accountId', async (req, res) => {
  const { accountId } = req.params;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('provisioning_orders')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data ?? [] });
});

export default router;
