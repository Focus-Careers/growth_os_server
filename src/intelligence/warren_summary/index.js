import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../config/anthropic.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a Warren summary message based on ITP and account analysis.
 */
export async function generateWarrenSummary(account_id, firstname) {
  const supabase = getSupabaseAdmin();

  // Fetch account info
  const { data: account } = await supabase
    .from('account')
    .select('organisation_name, description')
    .eq('id', account_id)
    .single();

  // Fetch all ITPs
  const { data: itps } = await supabase
    .from('itp')
    .select('id, name, itp_summary, itp_demographic, itp_pain_points')
    .eq('account_id', account_id)
    .order('created_at', { ascending: false });

  const itpList = itps ?? [];

  // Fetch lead and campaign stats per ITP
  let itpStats = [];
  if (itpList.length > 0) {
    const itpIds = itpList.map(i => i.id);

    const [leadsRes, campaignsRes] = await Promise.all([
      supabase.from('leads').select('itp_id, score, approved, rejected').in('itp_id', itpIds),
      supabase.from('campaigns').select('id, itp_id').eq('account_id', account_id),
    ]);

    const leads = leadsRes.data ?? [];
    const campaigns = campaignsRes.data ?? [];

    for (const itp of itpList) {
      const itpLeads = leads.filter(l => l.itp_id === itp.id);
      const scores = itpLeads.map(l => l.score);
      const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      const campaignCount = campaigns.filter(c => c.itp_id === itp.id).length;

      itpStats.push({
        name: itp.name ?? 'Unnamed ITP',
        summary: itp.itp_summary ?? '',
        demographic: itp.itp_demographic ?? '',
        leadCount: itpLeads.length,
        approved: itpLeads.filter(l => l.approved).length,
        avgScore,
        campaignCount,
      });
    }
  }

  // Build context
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  let context = '';
  if (account) {
    context += `Organisation: ${account.organisation_name ?? 'Unknown'}\nDescription: ${account.description ?? 'Not set'}\n\n`;
  }

  if (itpStats.length === 0) {
    context += 'The user has no target profiles defined yet.';
  } else {
    context += itpStats.map(s =>
      `ITP "${s.name}": ${s.summary}. ${s.leadCount} leads (avg score ${s.avgScore}), ${s.approved} approved, ${s.campaignCount} campaigns. Demographics: ${s.demographic}`
    ).join('\n');
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: prompt,
    messages: [{ role: 'user', content: `User's first name: ${firstname ?? 'there'}\n\n${context}` }],
  });

  return response.content[0].text.trim();
}
