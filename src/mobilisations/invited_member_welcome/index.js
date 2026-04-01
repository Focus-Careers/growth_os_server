import { getSupabaseAdmin } from '../../config/supabase.js';
import { getAnthropic } from '../../config/anthropic.js';

// Runs in the background after the welcome step is returned.
// Fetches account data, calls Haiku, posts the result as a real-time message.
async function generateAndPostStatus(user_details_id, account_id) {
  const supabase = getSupabaseAdmin();

  // Brief pause so the welcome message renders before typing dots appear
  await new Promise(r => setTimeout(r, 1500));

  await supabase.channel(`user:${user_details_id}`).send({
    type: 'broadcast', event: 'agent_typing', payload: { typing: true },
  });

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

    const prompt = `You are Watson, an AI growth coordinator for a GrowthOS workspace. A new team member has just joined. Write them a short welcome message (3-5 sentences):
1. Introduce yourself as Watson, their AI growth coordinator
2. Briefly describe who the company is targeting (use the target profile name and summarise who they are in plain English)
3. State the current position (approved leads, campaigns running) with the specific numbers
4. End with one clear, specific suggestion for what they should do next

Be warm but direct. No sign-off. No bullet points — write in flowing sentences.

Context:
${contextLines}`;

    const response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const statusMessage = response.content[0].text.trim();

    await supabase.channel(`user:${user_details_id}`).send({
      type: 'broadcast', event: 'agent_typing', payload: { typing: false },
    });

    await supabase.from('messages').insert({
      user_details_id,
      message_body: statusMessage,
      is_agent: true,
    });
  } catch (err) {
    // Clear typing indicator even on error
    await supabase.channel(`user:${user_details_id}`).send({
      type: 'broadcast', event: 'agent_typing', payload: { typing: false },
    }).catch(() => {});
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
