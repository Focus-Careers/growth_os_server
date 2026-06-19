const SMARTSENDERS_BASE_URL = 'https://smart-senders.smartlead.ai/api/v1';

function getApiKey() {
  return process.env.SMARTSENDERS_API_KEY ?? process.env.SMARTLEAD_API_KEY;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock mode
// Enable with PROVISIONING_MOCK=true to dry-run the full provisioning flow
// without touching SmartSenders (no charges). Order completes after
// PROVISIONING_MOCK_DELAY_MS (default 60s) so the poller can observe the
// PENDING → PROVISIONING → ACTIVE transition realistically.
// ──────────────────────────────────────────────────────────────────────────
function isMock() {
  return process.env.PROVISIONING_MOCK === 'true' || process.env.PROVISIONING_MOCK === '1';
}

const MOCK_DELAY_MS = () => parseInt(process.env.PROVISIONING_MOCK_DELAY_MS ?? '60000', 10);
const MOCK_ORDERS = new Map(); // order_id → { createdAt, payload }

const MOCK_VENDORS = [
  { id: 'mock-namecheap', name: 'Namecheap (Mock)', price: 4.50, pre_warmed_price: 9.00 },
  { id: 'mock-godaddy',   name: 'GoDaddy (Mock)',   price: 5.00, pre_warmed_price: 9.50 },
];

function mockMailboxes(domain, mailboxes) {
  return (mailboxes ?? []).map((m, i) => ({
    email: `${m.prefix ?? `${m.first_name}.${m.last_name}`.toLowerCase()}@${domain}`,
    first_name: m.first_name,
    last_name: m.last_name,
    smtp_host: 'smtp.mock.smartsenders.dev',
    smtp_port: 587,
    smtp_username: `${m.prefix ?? `${m.first_name}.${m.last_name}`.toLowerCase()}@${domain}`,
    smtp_password: `mock-pw-${i}-do-not-use`,
    imap_host: 'imap.mock.smartsenders.dev',
    imap_port: 993,
    smartlead_email_account_id: null,
  }));
}

async function smartsendersFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('[smartsenders] No API key (SMARTSENDERS_API_KEY / SMARTLEAD_API_KEY)');
    return { ok: false, status: 0, data: null, error: 'missing_api_key' };
  }
  const separator = path.includes('?') ? '&' : '?';
  const url = `${SMARTSENDERS_BASE_URL}${path}${separator}api_key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    console.error(`[smartsenders] ${options.method ?? 'GET'} ${path} fetch error:`, err.message);
    return { ok: false, status: 0, data: null, error: err.message };
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    console.error(`[smartsenders] ${options.method ?? 'GET'} ${path} → ${res.status}: non-JSON: ${text.slice(0, 200)}`);
    return { ok: false, status: res.status, data: null, error: 'non_json_response' };
  }
  if (!res.ok) {
    console.error(`[smartsenders] ${options.method ?? 'GET'} ${path} → ${res.status}:`, JSON.stringify(data));
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Fetch the catalogue of SmartSenders vendors (domain registrars / mailbox providers).
 * Used to verify API entitlement and pick a default vendor.
 */
export async function getVendors() {
  if (isMock()) {
    console.log('[smartsenders] MOCK: returning fake vendor list');
    return MOCK_VENDORS;
  }
  const { ok, data } = await smartsendersFetch('/vendors');
  if (!ok) return [];
  return Array.isArray(data) ? data : data?.vendors ?? data?.data ?? [];
}

/**
 * Place a SmartSenders order: register a domain, create mailboxes, configure DNS + Smartlead connection.
 *
 * @param {object} params
 * @param {string} params.vendor_id - Vendor to use (from getVendors())
 * @param {string} params.domain - Domain to register (e.g. "getacme.com")
 * @param {string} params.forwarding_domain - Where the domain should redirect (e.g. "https://acme.com")
 * @param {Array<{first_name: string, last_name: string, prefix?: string}>} params.mailboxes - Mailbox personas
 * @param {object} params.user_details - Registrant contact details
 * @param {boolean} [params.pre_warmed=false] - Pre-warmed mailbox tier
 * @returns {Promise<{ok: boolean, order_id?: string, raw: object}>}
 */
export async function placeOrder({ vendor_id, domain, forwarding_domain, mailboxes, user_details, pre_warmed = false }) {
  console.log(`[smartsenders] Placing order: domain=${domain}, mailboxes=${mailboxes?.length}, vendor=${vendor_id}${isMock() ? ' [MOCK]' : ''}`);
  const payload = {
    vendor_id,
    domain,
    forwarding_domain,
    mailboxes: (mailboxes ?? []).map(m => ({
      first_name: m.first_name,
      last_name: m.last_name,
      prefix: m.prefix ?? `${m.first_name}.${m.last_name}`.toLowerCase(),
    })),
    user_details,
    pre_warmed,
  };

  if (isMock()) {
    const order_id = `mock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    MOCK_ORDERS.set(order_id, { createdAt: Date.now(), payload });
    console.log(`[smartsenders] MOCK: order ${order_id} placed; will complete in ~${MOCK_DELAY_MS() / 1000}s`);
    return {
      ok: true,
      status: 200,
      order_id,
      raw: { mock: true, order_id, status: 'pending', message: 'Mock order accepted' },
    };
  }

  const { ok, data, status } = await smartsendersFetch('/place-order', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const order_id = data?.order_id ?? data?.id ?? data?.data?.order_id ?? null;
  return { ok, status, order_id: order_id ? String(order_id) : null, raw: data };
}

/**
 * Get the status of a SmartSenders order.
 */
export async function getOrderStatus(orderId) {
  if (isMock()) {
    const stored = MOCK_ORDERS.get(orderId);
    // If the server restarted we'll have no record — synthesise "processing" so the
    // poller keeps polling; it'll stall out at 48h like the real flow.
    if (!stored) {
      console.log(`[smartsenders] MOCK: no record for ${orderId}, returning processing`);
      return { ok: true, status: 200, raw: { mock: true, status: 'processing', order_id: orderId } };
    }
    const elapsed = Date.now() - stored.createdAt;
    if (elapsed < MOCK_DELAY_MS()) {
      return {
        ok: true, status: 200,
        raw: { mock: true, status: 'processing', order_id: orderId, elapsed_ms: elapsed },
      };
    }
    // Completed — return synthesised mailbox payload
    const mailboxes = mockMailboxes(stored.payload.domain, stored.payload.mailboxes);
    console.log(`[smartsenders] MOCK: order ${orderId} completed (${mailboxes.length} mailboxes)`);
    return {
      ok: true, status: 200,
      raw: {
        mock: true,
        status: 'completed',
        order_id: orderId,
        domain: stored.payload.domain,
        mailboxes,
      },
    };
  }
  const { ok, data, status } = await smartsendersFetch(`/orders/${encodeURIComponent(orderId)}`);
  return { ok, status, raw: data };
}

/**
 * Health/ping check — returns true if the API key is accepted on SmartSenders.
 */
export async function ping() {
  if (isMock()) return { ok: true, status: 200, mock: true };
  const { ok, status } = await smartsendersFetch('/vendors');
  return { ok, status };
}
