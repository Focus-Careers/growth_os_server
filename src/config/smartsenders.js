const SMARTSENDERS_BASE_URL = 'https://smart-senders.smartlead.ai/api/v1';

function getApiKey() {
  return process.env.SMARTSENDERS_API_KEY ?? process.env.SMARTLEAD_API_KEY;
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
  console.log(`[smartsenders] Placing order: domain=${domain}, mailboxes=${mailboxes?.length}, vendor=${vendor_id}`);
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
  const { ok, data, status } = await smartsendersFetch('/place-order', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const order_id = data?.order_id ?? data?.id ?? data?.data?.order_id ?? null;
  return { ok, status, order_id: order_id ? String(order_id) : null, raw: data };
}

/**
 * Get the status of a SmartSenders order.
 * Returned shape (best guess until verified):
 *   { status: 'pending'|'processing'|'completed'|'failed',
 *     domain, mailboxes: [{ email, smartlead_email_account_id?, smtp_host?, smtp_port?, smtp_password?, imap_host?, imap_port? }] }
 */
export async function getOrderStatus(orderId) {
  const { ok, data, status } = await smartsendersFetch(`/orders/${encodeURIComponent(orderId)}`);
  return { ok, status, raw: data };
}

/**
 * Health/ping check — returns true if the API key is accepted on SmartSenders.
 */
export async function ping() {
  const { ok, status } = await smartsendersFetch('/vendors');
  return { ok, status };
}
