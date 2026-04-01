import { getSupabaseAdmin } from '../../config/supabase.js';
import { getAnthropic } from '../../config/anthropic.js';

export default async function invitedMemberWelcome(messages, context = {}) {
  const user_details_id = context.user_details_id ?? null;

  let firstname = '';
  let orgName = 'your company';
  let companyStatus = "I'll fill you in on where things stand as you settle in.";

  if (user_details_id) {
    const { data: ud } = await getSupabaseAdmin()
      .from('user_details')
      .select('firstname, account_id')
      .eq('id', user_details_id)
      .single();

    firstname = ud?.firstname ?? '';

    if (ud?.account_id) {
      const accountId = ud.account_id;

      const [{ data: account }, { data: itps }] = await Promise.all([
        getSupabaseAdmin()
          .from('account')
          .select('organisation_name, organisation_website, description')
          .eq('id', accountId)
          .single(),
        getSupabaseAdmin()
          .from('itp')
          .select('id, name')
          .eq('account_id', accountId),
      ]);

      orgName = account?.organisation_name ?? 'your company';

      // Approved lead counts per ITP
      const itpSummaries = await Promise.all((itps ?? []).map(async itp => {
        const { count } = await getSupabaseAdmin()
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('itp_id', itp.id)
          .eq('approved', true);
        return `"${itp.name}" — ${count ?? 0} approved leads`;
      }));

      const { count: campaignCount } = await getSupabaseAdmin()
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId);

      const contextLines = [
        `Company: ${orgName}`,
        account?.organisation_website ? `Website: ${account.organisation_website}` : null,
        account?.description ? `What they do: ${account.description}` : null,
        itpSummaries.length > 0
          ? `Target profiles: ${itpSummaries.join(', ')}`
          : 'No target profiles built yet',
        `Campaigns: ${campaignCount ?? 0} set up`,
      ].filter(Boolean).join('\n');

      try {
        const prompt = `You are Watson, a sharp and direct AI growth coordinator. A new team member has just joined this company's GrowthOS workspace. Write 2-3 sentences giving them a quick sense of where things currently stand — what's been built, what's in motion, what's next. Be specific and use the data below. Write in Watson's voice: confident, warm, no fluff. Address them directly as "you".

Company context:
${contextLines}`;

        const response = await getAnthropic().messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        });
        companyStatus = response.content[0].text.trim();
      } catch (err) {
        console.error('[invited_member_welcome] Haiku error:', err);
      }
    }
  }

  const greeting = firstname ? `Hey ${firstname}` : 'Hey';

  return {
    id: 'welcome',
    type: 'end_flow',
    messages: [
      `${greeting}, welcome to ${orgName} on GrowthOS.`,
      `Here's who you're working with. I'm Watson — I set the strategy and keep everything coordinated. Belfort is your lead gen expert; he searches the web for companies that match your ideal target profile, scores them, and finds contact details. Warren is the business analyst — he digs into your customer base, spots patterns, and keeps your targeting sharp. Draper runs your outbound campaigns: email sequences, sending schedules, reply tracking. And Pepper handles the admin layer — account settings, team management, senders, all of that.`,
      companyStatus,
      `Take a look around. I'm here whenever you need me.`,
    ],
    options: null,
    next_id: null,
    response_key: null,
    sidebar: null,
  };
}
