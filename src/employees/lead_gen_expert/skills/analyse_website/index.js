import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAnthropic } from '../../../../config/anthropic.js';
import { processSkillOutput } from '../../../../intelligence/skill_output_processor/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadPrompt() {
  return readFile(join(__dirname, 'prompt.md'), 'utf-8');
}

async function fetchWebsiteText(url) {
  const normalised = url.startsWith('http') ? url : `https://${url}`;
  const res = await fetch(normalised, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  // Strip tags to get readable text for the model
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
}

export async function executeSkill({ website, user_details_id }) {
  const [prompt, websiteText] = await Promise.all([
    loadPrompt(),
    fetchWebsiteText(website),
  ]);

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nWebsite URL: ${website}\n\nWebsite content:\n${websiteText}`,
      },
    ],
  });

  const raw = message.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let analysis;
  try {
    analysis = JSON.parse(raw);
  } catch (parseError) {
    console.error('[analyse_website] Failed to parse Claude response as JSON:', parseError.message, '| raw text:', raw);
    analysis = {};
  }

  await processSkillOutput({
    employee: 'lead_gen_expert',
    skill_name: 'analyse_website',
    user_details_id,
    output: analysis,
  });

  return { user_details_id, analysis };
}
