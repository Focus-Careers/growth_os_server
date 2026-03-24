import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function executeSkill({ organisation_name, organisation_website, description, problem_solved, user_details_id }) {
  const prompt = await readFile(join(__dirname, 'prompt.md'), 'utf-8');

  const userMessage = JSON.stringify({ organisation_name, organisation_website, description, problem_solved }, null, 2);

  const response = await getAnthropic().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\nOrganisation details:\n${userMessage}` }],
  });

  const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const itp = JSON.parse(raw);

  await processSkillOutput({
    employee: 'business_analyst',
    skill_name: 'define_itp',
    user_details_id,
    output: itp,
  });

  return { user_details_id, itp };
}
