import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { getSupabaseAdmin } from '../../../../config/supabase.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function executeSkill({ organisation_name, organisation_website, description, problem_solved, user_details_id }) {
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  // Fetch customer_profile from account if available — used to inform the ITP
  let customer_profile = null;
  if (user_details_id) {
    const { data: ud } = await getSupabaseAdmin()
      .from('user_details').select('account_id').eq('id', user_details_id).single();
    if (ud?.account_id) {
      const { data: account } = await getSupabaseAdmin()
        .from('account').select('customer_profile').eq('id', ud.account_id).single();
      customer_profile = account?.customer_profile ?? null;
    }
  }

  const orgDetails = { organisation_name, organisation_website, description, problem_solved };

  let userMessage = `Organisation details:\n${JSON.stringify(orgDetails, null, 2)}`;

  if (customer_profile) {
    const topSics = (customer_profile.top_sic_codes ?? [])
      .slice(0, 5)
      .map(s => `${s.code} (${s.count} customers)`)
      .join(', ');
    userMessage += `\n\nCustomer profile (from ${customer_profile.matched_count} existing customers matched on Companies House):`;
    userMessage += `\n- Top SIC codes: ${topSics || 'none'}`;
    if (customer_profile.avg_company_age != null) {
      userMessage += `\n- Average company age: ${customer_profile.avg_company_age} years`;
    }
    console.log(`[define_itp] Using customer_profile: ${customer_profile.matched_count} matched customers`);
  } else {
    console.log('[define_itp] No customer_profile available — using org details only');
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\n${userMessage}` }],
  });

  const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let itp;
  try {
    itp = JSON.parse(raw);
  } catch (parseError) {
    console.error('[define_itp] Failed to parse Claude response as JSON:', parseError.message, '| raw text:', raw);
    itp = {};
  }

  await processSkillOutput({
    employee: 'business_analyst',
    skill_name: 'define_itp',
    user_details_id,
    output: itp,
  });

  return { user_details_id, itp };
}
