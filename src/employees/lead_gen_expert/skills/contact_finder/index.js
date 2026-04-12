import { getOpenAI } from '../../../../config/openai.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const APOLLO_BASE_URL = 'https://api.apollo.io/v1';

async function getDecisionMakerTitles(itpDemographic) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5-nano',
    max_completion_tokens: 256,
    messages: [{
      role: 'user',
      content: `Extract 5-8 specific job titles of decision makers who would be involved in purchasing decisions from this description. Return ONLY a valid JSON array of title strings, nothing else.\n\nDescription: ${itpDemographic}`,
    }],
  });
  const raw = response.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(raw);
  } catch (parseError) {
    console.error('[contact_finder] Failed to parse Claude response as JSON:', parseError.message, '| raw text:', raw);
    return [];
  }
}

async function searchApollo(domain, titles, perPage = 10) {
  console.log(`[contact_finder] Apollo search → domain: ${domain}, titles: ${JSON.stringify(titles)}, perPage: ${perPage}`);
  const body = {
    q_organization_domains: domain,
    per_page: perPage,
    page: 1,
  };
  if (titles && titles.length > 0) body.person_titles = titles;
  const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
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

export async function executeSkill({ user_details_id, target_id, lead_id, silent = false }) {
  // Accept target_id or lead_id (backward compat)
  const resolvedTargetId = target_id ?? lead_id;
  console.log(`[contact_finder] Starting for target ${resolvedTargetId}`);

  const { data: target } = await getSupabaseAdmin()
    .from('targets')
    .select('id, title, link, domain')
    .eq('id', resolvedTargetId)
    .single();

  if (!target) throw new Error(`Target ${resolvedTargetId} not found`);

  // Get ITP demographic via leads table
  const { data: leadForItp } = await getSupabaseAdmin()
    .from('leads')
    .select('itp_id')
    .eq('target_id', resolvedTargetId)
    .limit(1)
    .maybeSingle();

  let itpDemographic = null;
  let accountId = null;
  if (leadForItp?.itp_id) {
    const { data: itp } = await getSupabaseAdmin()
      .from('itp')
      .select('itp_demographic, account_id')
      .eq('id', leadForItp.itp_id)
      .single();
    itpDemographic = itp?.itp_demographic ?? null;
    accountId = itp?.account_id ?? null;
  }

  if (!accountId) {
    // Fallback: get account_id from user_details
    const { data: ud } = await getSupabaseAdmin()
      .from('user_details').select('account_id').eq('id', user_details_id).single();
    accountId = ud?.account_id;
  }

  let domain = target.domain;
  if (!domain) {
    try {
      domain = new URL(target.link).hostname.replace(/^www\./, '');
    } catch {
      throw new Error(`Invalid target URL: ${target.link}`);
    }
  }

  console.log(`[contact_finder] Target URL: ${target.link} → domain: ${domain}`);

  // Extract decision maker titles from ITP demographic
  let titles;
  if (itpDemographic) {
    try {
      titles = await getDecisionMakerTitles(itpDemographic);
      console.log(`[contact_finder] Decision maker titles:`, titles);
    } catch (e) {
      console.error('[contact_finder] Failed to extract titles, using fallback:', e.message);
      titles = ['Director', 'Managing Director', 'CEO', 'Owner', 'Head of Procurement', 'Purchasing Manager'];
    }
  } else {
    titles = ['Director', 'Managing Director', 'CEO', 'Owner', 'Head of Procurement', 'Purchasing Manager'];
  }

  // Search Apollo for people at this domain with matching titles
  const apolloData = await searchApollo(domain, titles);
  let people = apolloData.people ?? [];

  // Broadened fallback: if title-based search returned 0, search without title filter
  if (people.length === 0) {
    console.log(`[contact_finder] Title search empty for ${domain}, trying broadened fallback (no title filter)`);
    const fallbackData = await searchApollo(domain, [], 5);
    people = fallbackData.people ?? [];
  }

  if (people.length === 0) {
    console.log(`[contact_finder] No people found for ${domain} after fallback`);
    return { user_details_id, target_id: resolvedTargetId, contacts: [] };
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
      .eq('target_id', resolvedTargetId)
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      console.log(`[contact_finder] Already exists: ${email}`);
      continue;
    }

    const { data: contact, error } = await getSupabaseAdmin()
      .from('contacts')
      .insert({
        account_id: accountId,
        target_id: resolvedTargetId,
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

  console.log(`[contact_finder] Done — ${saved.length} contacts saved for target ${resolvedTargetId}`);

  if (!silent) {
    await processSkillOutput({
      employee: 'lead_gen_expert',
      skill_name: 'contact_finder',
      user_details_id,
      output: { target_id: resolvedTargetId, contacts: saved },
    });
  }

  return { user_details_id, target_id: resolvedTargetId, contacts: saved };
}
