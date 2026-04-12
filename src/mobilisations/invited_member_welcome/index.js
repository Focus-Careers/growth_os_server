import { getSupabaseAdmin } from '../../config/supabase.js';
import { getOpenAI } from '../../config/openai.js';

async function broadcastTyping(supabase, user_details_id, typing) {
  await supabase.channel(`user:${user_details_id}`).send({
    type: 'broadcast', event: 'agent_typing', payload: { typing },
  }).catch(() => {});
}

async function insertMessage(supabase, user_details_id, message_body) {
  await supabase.from('messages').insert({ user_details_id, message_body, is_agent: true });
}

// Runs in the background after the welcome step is returned.
// Fetches account data, calls Haiku, posts two messages with a typing gap between them.
async function generateAndPostStatus(user_details_id, account_id) {
  const supabase = getSupabaseAdmin();

  // Brief pause so the welcome message renders before typing dots appear
  await new Promise(r => setTimeout(r, 1500));

  await broadcastTyping(supabase, user_details_id, true);

  try {
    const [{ data: account }, { data: itps }, { count: campaignCount }] = await Promise.all([
      supabase.from('account').select('organisation_name, organisation_website, description').eq('id', account_id).single(),
      supabase.from('itp').select('id, name, itp_summary').eq('account_id', account_id),
      supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('account_id', account_id),
    ]);

    const itpSummaries = await Promise.all((itps ?? []).map(async itp => {
      const { count } = await supabase
        .from('leads').select('id', { count: 'exact', head: true })
        .eq('itp_id', itp.id).eq('approved', true);
      return `"${itp.name}" (${count ?? 0} approved leads) — ${itp.itp_summary ?? 'no description'}`;
    }));

    const contextLines = [
      account?.description ? `What they do: ${account.description}` : null,
      itpSummaries.length > 0 ? `Target profiles:\n${itpSummaries.map(s => `- ${s}`).join('\n')}` : 'No target profiles yet',
      `Campaigns running: ${campaignCount ?? 0}`,
    ].filter(Boolean).join('\n');

    const prompt = `You are Watson, an AI growth coordinator inside GrowthOS. A new team member has just joined this workspace. Write exactly two messages, returned as a JSON array of two strings.

Message 1: Introduce yourself as Watson and describe who the company is targeting. Do NOT open with "welcome" or any greeting — dive straight into who you are and what the team is working on. Describe the target profile in plain English (not just the name). Keep it to 2-3 sentences.

Message 2: State the current pipeline position using the specific numbers (approved leads, campaigns running). Then give one clear, specific suggestion for what the new member should do next — this must be something GrowthOS can actually do. The available actions are: ask Watson to find more leads, ask Watson to refine the target profile, ask Watson to create a campaign, explore and approve leads in Belfort, set up or launch a campaign in Draper, analyse customers in Warren. Reference the relevant agent or feature by name. Keep it to 2-3 sentences.

Be warm but direct. No sign-off. No bullet points. Return only the JSON array — no other text.

Context:
${contextLines}`;

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-5-nano',
      max_completion_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.choices[0].message.content.trim();

    let messages;
    try {
      // Strip markdown code fences and extract the JSON array
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const match = stripped.match(/\[[\s\S]*\]/);
      messages = JSON.parse(match ? match[0] : stripped);
      if (!Array.isArray(messages) || messages.length < 2) throw new Error('unexpected shape');
    } catch {
      // Fallback: treat the whole response as a single message
      messages = [raw];
    }

    // Post first message
    await broadcastTyping(supabase, user_details_id, false);
    await insertMessage(supabase, user_details_id, messages[0]);

    if (messages[1]) {
      // Gap before second message
      await new Promise(r => setTimeout(r, 1200));
      await broadcastTyping(supabase, user_details_id, true);
      await new Promise(r => setTimeout(r, 1800));
      await broadcastTyping(supabase, user_details_id, false);
      await insertMessage(supabase, user_details_id, messages[1]);
    }
  } catch (err) {
    await broadcastTyping(supabase, user_details_id, false);
    throw err;
  }
}

export default async function invitedMemberWelcome(messages, context = {}) {
  const user_details_id = context.user_details_id ?? null;

  let firstname = '';
  let orgName = 'your company';

  if (user_details_id) {
    const { data: ud } = await getSupabaseAdmin()
      .from('user_details')
      .select('firstname, account_id')
      .eq('id', user_details_id)
      .single();

    firstname = ud?.firstname ?? '';

    if (ud?.account_id) {
      const { data: account } = await getSupabaseAdmin()
        .from('account').select('organisation_name').eq('id', ud.account_id).single();
      orgName = account?.organisation_name ?? 'your company';

      // Fire status generation in background — don't await
      generateAndPostStatus(user_details_id, ud.account_id)
        .catch(err => console.error('[invited_member_welcome] status error:', err));
    }
  }

  const greeting = firstname ? `Hey ${firstname}` : 'Hey';

  return {
    id: 'welcome',
    type: 'end_flow',
    messages: [`${greeting}, welcome to ${orgName} on GrowthOS.`],
    options: null,
    next_id: null,
    response_key: null,
    sidebar: null,
  };
}
