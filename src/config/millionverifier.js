/**
 * MillionVerifier email verification client.
 *
 * Verifies whether an email address is deliverable before we save it to the
 * contacts table or push it to Smartlead. Protects sender domain reputation
 * by keeping bounce rate below the 2% threshold.
 *
 * Results:
 *   ok        — deliverable, safe to send
 *   catch_all — domain accepts all addresses; can't confirm mailbox exists
 *   unknown   — verification couldn't complete (temporary or inconclusive)
 *   invalid   — definitely undeliverable — do not save or send
 *
 * Fails open: if the API is unreachable or returns an unexpected error,
 * returns { status: null } so a third-party outage never blocks enrichment.
 */

const BASE_URL = 'https://api.millionverifier.com/api/v3/';

function getApiKey() {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) throw new Error('MILLIONVERIFIER_API_KEY not set');
  return key;
}

/**
 * Verify a single email address.
 *
 * @param {string} email
 * @returns {Promise<{
 *   status: 'ok' | 'catch_all' | 'unknown' | 'invalid' | null,
 *   disposable: boolean,
 *   free: boolean,
 *   raw: object | null,
 * }>}
 */
export async function verifyEmail(email) {
  if (!email) return { status: 'invalid', disposable: false, free: false, raw: null };

  try {
    const params = new URLSearchParams({
      api: getApiKey(),
      email: email.toLowerCase().trim(),
    });

    const res = await fetch(`${BASE_URL}?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!res.ok) {
      console.warn(`[millionverifier] HTTP ${res.status} for ${email}`);
      return { status: null, disposable: false, free: false, raw: null };
    }

    const data = await res.json();

    // MillionVerifier result values:
    //   'ok'        — valid and deliverable
    //   'catch_all' — catch-all domain
    //   'unknown'   — couldn't verify
    //   'invalid'   — bad address
    //   'disposable'— throwaway inbox (treat as invalid)
    //   'error'     — API-level error
    const rawResult = data.result ?? data.subresult ?? 'unknown';
    const isDisposable = !!data.disposable;
    const isFree = !!data.free;

    let status;
    if (isDisposable || rawResult === 'disposable') {
      status = 'invalid'; // disposable inboxes are useless for B2B
    } else if (rawResult === 'ok') {
      status = 'ok';
    } else if (rawResult === 'catch_all') {
      status = 'catch_all';
    } else if (rawResult === 'invalid' || rawResult === 'error') {
      status = 'invalid';
    } else {
      status = 'unknown';
    }

    console.log(`[millionverifier] ${email} → ${status}${isDisposable ? ' (disposable)' : ''}`);
    return { status, disposable: isDisposable, free: isFree, raw: data };

  } catch (err) {
    // Fail open — don't block enrichment due to a network/timeout issue
    console.warn(`[millionverifier] Verification error for ${email}: ${err.message} — failing open`);
    return { status: null, disposable: false, free: false, raw: null };
  }
}
