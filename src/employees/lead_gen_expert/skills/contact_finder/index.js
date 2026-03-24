import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';

const APOLLO_BASE_URL = 'https://api.apollo.io/v1';

async function getDecisionMakerTitles(itpDemographic) {
  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Extract 5-8 specific job titles of decision makers who would be involved in purchasing decisions from this description. Return ONLY a valid JSON array of title strings, nothing else.\n\nDescription: ${itpDemographic}`,
    }],
  });
  const raw = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(raw);
}

async function searchApollo(domain, titles) {
  console.log(`[contact_finder] Apollo search → domain: ${domain}, titles: ${JSON.stringify(titles)}`);
  const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      q_organization_domains: domain,
      person_titles: titles,
      per_page: 10,
      page: 1,
    }),
  });
  const data = await res.json();
  console.log(`[contact_finder] Apollo status: ${res.status} | people returned: ${data.people?.length ?? 0}`);
  if (!res.ok) console.error('[contact_finder] Apollo error:', JSON.stringify(data));
  return data;
}

async function revealEmail(firstName, lastName, domain) {
  console.log(`[contact_finder] Revealing email for ${firstName} ${lastName} @ ${domain}`);
  const res = await fetch(`${APOLLO_BASE_URL}/people/match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      domain,
      reveal_personal_emails: true,
      reveal_phone_number: false,
    }),
  });
  const data = await res.json();
  const email = data.person?.email ?? null;
  console.log(`[contact_finder] Revealed: ${email ?? 'none'}`);
  return email;
}

export async function executeSkill({ user_details_id, lead_id }) {
  console.log(`[contact_finder] Starting for lead ${lead_id}`);

  const { data: lead } = await getSupabaseAdmin()
    .from('leads')
    .select('id, title, link, itp')
    .eq('id', lead_id)
    .single();

  if (!lead) throw new Error(`Lead ${lead_id} not found`);

  const { data: itp } = await getSupabaseAdmin()
    .from('itp')
    .select('itp_demographic, account_id')
    .eq('id', lead.itp)
    .single();

  if (!itp) throw new Error(`ITP not found for lead ${lead_id}`);

  let domain;
  try {
    domain = new URL(lead.link).hostname.replace(/^www\./, '');
  } catch {
    throw new Error(`Invalid lead URL: ${lead.link}`);
  }

  console.log(`[contact_finder] Lead URL: ${lead.link} → domain: ${domain}`);

  // Extract decision maker titles from ITP demographic
  let titles;
  try {
    titles = await getDecisionMakerTitles(itp.itp_demographic);
    console.log(`[contact_finder] Decision maker titles:`, titles);
  } catch (e) {
    console.error('[contact_finder] Failed to extract titles, using fallback:', e.message);
    titles = ['Director', 'Managing Director', 'CEO', 'Owner', 'Head of Procurement', 'Purchasing Manager'];
  }

  // Search Apollo for people at this domain with matching titles
  const apolloData = await searchApollo(domain, titles);
  const people = apolloData.people ?? [];

  if (people.length === 0) {
    console.log(`[contact_finder] No people found for ${domain}`);
    return { user_details_id, lead_id, contacts: [] };
  }

  const saved = [];

  for (const person of people) {
    let email = person.email ?? null;

    // Only attempt reveal if Apollo confirms an email exists for this person
    if (!email && person.has_email && person.first_name) {
      email = await revealEmail(person.first_name, person.last_name ?? null, domain);
    } else if (!person.has_email) {
      console.log(`[contact_finder] No email in Apollo for ${person.first_name} — skipping`);
      continue;
    }

    if (!email) {
      console.log(`[contact_finder] Reveal returned no email for ${person.first_name} — skipping`);
      continue;
    }

    // Skip duplicates
    const { data: existing } = await getSupabaseAdmin()
      .from('contacts')
      .select('id')
      .eq('lead_id', lead_id)
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      console.log(`[contact_finder] Already exists: ${email}`);
      continue;
    }

    const { data: contact, error } = await getSupabaseAdmin()
      .from('contacts')
      .insert({
        account_id: itp.account_id,
        lead_id,
        first_name: person.first_name ?? null,
        last_name: person.last_name ?? null,
        email,
        role: person.title ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error(`[contact_finder] Insert error for ${email}:`, error.message);
    } else {
      console.log(`[contact_finder] Saved: ${person.first_name} ${person.last_name ?? ''} <${email}> — ${person.title}`);
      saved.push(contact);
    }
  }

  console.log(`[contact_finder] Done — ${saved.length} contacts saved for lead ${lead_id}`);
  return { user_details_id, lead_id, contacts: saved };
}
