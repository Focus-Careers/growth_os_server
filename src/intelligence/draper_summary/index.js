import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOpenAI } from '../../config/openai.js';
import { getSupabaseAdmin } from '../../config/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a Draper summary message based on current campaign state.
 */
export async function generateDraperSummary(account_id, firstname) {
  const supabase = getSupabaseAdmin();

  // Fetch all campaigns for this account
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, status, num_emails, tone, created_at')
    .eq('account_id', account_id)
    .order('created_at', { ascending: false });

  const campaignList = campaigns ?? [];

  // Fetch contact stats per campaign
  let campaignStats = [];
  for (const campaign of campaignList) {
    const { data: contacts } = await supabase
      .from('campaign_contacts')
      .select('status')
      .eq('campaign_id', campaign.id);

    const counts = {};
    for (const c of (contacts ?? [])) {
      counts[c.status] = (counts[c.status] ?? 0) + 1;
    }

    campaignStats.push({
      name: campaign.name,
      status: campaign.status,
      total_contacts: (contacts ?? []).length,
      sent: counts['sent'] ?? 0,
      opened: counts['opened'] ?? 0,
      replied: counts['replied'] ?? 0,
      bounced: (counts['bounced'] ?? 0) + (counts['failed'] ?? 0),
    });
  }

  // Build context for Haiku
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  let context;
  if (campaignStats.length === 0) {
    context = 'The user has no campaigns yet.';
  } else {
    context = campaignStats.map(c =>
      `Campaign "${c.name}" (${c.status}): ${c.total_contacts} contacts, ${c.sent} sent, ${c.opened} opened, ${c.replied} replied, ${c.bounced} bounced`
    ).join('\n');
  }

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5-nano',
    max_completion_tokens: 256,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `User's first name: ${firstname ?? 'there'}\n\n${context}` },
    ],
  });

  return response.choices[0].message.content.trim();
}
