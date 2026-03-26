const SMARTLEAD_BASE_URL = 'https://server.smartlead.ai/api/v1';

function getApiKey() {
  return process.env.SMARTLEAD_API_KEY;
}

async function smartleadFetch(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${SMARTLEAD_BASE_URL}${path}${separator}api_key=${getApiKey()}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[smartlead] ${options.method ?? 'GET'} ${path} → ${res.status}:`, JSON.stringify(data));
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Create a new campaign in Smartlead. Returns in DRAFTED status.
 */
export async function createCampaign(name) {
  console.log(`[smartlead] Creating campaign: ${name}`);
  const { ok, data } = await smartleadFetch('/campaigns/create', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!ok) return null;
  console.log(`[smartlead] Campaign created: id=${data.id}`);
  return data;
}

/**
 * Save email sequences to a campaign.
 * @param {number} campaignId - Smartlead campaign ID
 * @param {Array} sequences - Array of { seq_number, delay_in_days, subject, body }
 */
export async function saveSequences(campaignId, sequences) {
  console.log(`[smartlead] Saving ${sequences.length} sequences to campaign ${campaignId}`);
  const formatted = sequences.map(seq => ({
    seq_number: seq.seq_number,
    seq_delay_details: { delay_in_days: seq.delay_in_days },
    subject: seq.subject,
    email_body: seq.body,
  }));
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/sequences`, {
    method: 'POST',
    body: JSON.stringify({ sequences: formatted }),
  });
  if (!ok) {
    // Retry with array format (some API versions expect bare array)
    console.log('[smartlead] Retrying sequences with bare array format');
    const retry = await smartleadFetch(`/campaigns/${campaignId}/sequences`, {
      method: 'POST',
      body: JSON.stringify(formatted),
    });
    return retry.ok ? retry.data : null;
  }
  return ok ? data : null;
}

/**
 * Set campaign schedule.
 */
export async function setSchedule(campaignId, schedule = {}) {
  console.log(`[smartlead] Setting schedule for campaign ${campaignId}`);
  const defaults = {
    timezone: schedule.timezone ?? 'Europe/London',
    days_of_the_week: schedule.days_of_the_week ?? [1, 2, 3, 4, 5],
    start_hour: schedule.start_hour ?? '09:00',
    end_hour: schedule.end_hour ?? '17:00',
    min_time_btw_emails: schedule.min_time_btw_emails ?? 24,
    max_new_leads_per_day: schedule.max_new_leads_per_day ?? 50,
  };
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/schedule`, {
    method: 'POST',
    body: JSON.stringify(defaults),
  });
  return ok ? data : null;
}

/**
 * Configure campaign settings.
 */
export async function setCampaignSettings(campaignId) {
  console.log(`[smartlead] Setting campaign settings for ${campaignId}`);
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/settings`, {
    method: 'POST',
    body: JSON.stringify({
      track_settings: [],
      stop_lead_settings: 'REPLY_TO_AN_EMAIL',
      send_as_plain_text: false,
      follow_up_percentage: 100,
    }),
  });
  return ok ? data : null;
}

/**
 * Get all email accounts from Smartlead.
 */
export async function getEmailAccounts() {
  const { ok, data } = await smartleadFetch('/email-accounts/?offset=0&limit=100');
  return ok ? (data ?? []) : [];
}

/**
 * Create an email account in Smartlead.
 */
export async function createEmailAccount({ from_name, from_email, smtp_host, smtp_port, smtp_username, smtp_password, imap_host, imap_port, max_email_per_day }) {
  console.log(`[smartlead] Creating email account: ${from_email}`);
  const { ok, data } = await smartleadFetch('/email-accounts/save', {
    method: 'POST',
    body: JSON.stringify({
      from_name,
      from_email,
      username: smtp_username ?? from_email,
      password: smtp_password,
      smtp_host,
      smtp_port: smtp_port ?? 587,
      smtp_port_type: 'TLS',
      imap_host,
      imap_port: imap_port ?? 993,
      max_email_per_day: max_email_per_day ?? 50,
    }),
  });
  if (!ok) return null;
  console.log(`[smartlead] Email account created: id=${data.id}`);
  return data;
}

/**
 * Attach an email account to a campaign.
 */
export async function attachEmailAccount(campaignId, emailAccountId) {
  console.log(`[smartlead] Attaching email account ${emailAccountId} to campaign ${campaignId}`);
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/email-accounts`, {
    method: 'POST',
    body: JSON.stringify({ email_account_id: emailAccountId }),
  });
  return ok ? data : null;
}

/**
 * Add leads to a campaign. Max 100 per request.
 * @param {number} campaignId
 * @param {Array} leads - Array of { email, first_name, last_name, company_name, ... }
 */
export async function addLeads(campaignId, leads) {
  console.log(`[smartlead] Adding ${leads.length} leads to campaign ${campaignId}`);
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/leads`, {
    method: 'POST',
    body: JSON.stringify({
      lead_list: leads,
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_other_campaign: false,
        ignore_community_bounce_list: false,
      },
    }),
  });
  if (ok) {
    console.log(`[smartlead] Leads added: ${data.added_count ?? 0} added, ${data.skipped_count ?? 0} skipped`);
  }
  return ok ? data : null;
}

/**
 * Update campaign status. Use 'ACTIVE' to start sending, 'PAUSED' to pause.
 * NOTE: Currently in testing mode — do NOT set to ACTIVE.
 */
export async function updateCampaignStatus(campaignId, status) {
  console.log(`[smartlead] Updating campaign ${campaignId} status to ${status}`);
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return ok ? data : null;
}

/**
 * Get campaign statistics.
 */
export async function getCampaignStatistics(campaignId) {
  const { ok, data } = await smartleadFetch(`/campaigns/${campaignId}/statistics`);
  return ok ? data : null;
}
