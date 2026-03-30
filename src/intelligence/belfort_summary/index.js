import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../config/anthropic.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a Belfort summary message based on current lead pipeline state.
 */
export async function generateBelfortSummary(account_id, firstname) {
  const supabase = getSupabaseAdmin();

  // Fetch all ITPs for this account
  const { data: itps } = await supabase
    .from('itp')
    .select('id, name')
    .eq('account_id', account_id)
    .order('created_at', { ascending: false });

  const itpList = itps ?? [];

  // Fetch lead stats per ITP
  let itpStats = [];
  if (itpList.length > 0) {
    const itpIds = itpList.map(i => i.id);
    const { data: leads } = await supabase
      .from('leads')
      .select('itp_id, score, approved, rejected')
      .in('itp_id', itpIds);

    for (const itp of itpList) {
      const itpLeads = (leads ?? []).filter(l => l.itp_id === itp.id);
      const approved = itpLeads.filter(l => l.approved).length;
      const rejected = itpLeads.filter(l => l.rejected).length;
      const pending = itpLeads.filter(l => !l.approved && !l.rejected).length;
      const scores = itpLeads.map(l => l.score);
      const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

      itpStats.push({
        name: itp.name ?? 'Unnamed ITP',
        total: itpLeads.length,
        approved,
        rejected,
        pending,
        avgScore,
      });
    }
  }

  // Build context
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  let context;
  if (itpStats.length === 0) {
    context = 'The user has no target profiles or leads yet.';
  } else {
    context = itpStats.map(s =>
      `ITP "${s.name}": ${s.total} leads found, ${s.approved} approved, ${s.rejected} rejected, ${s.pending} pending review, avg score ${s.avgScore}`
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
