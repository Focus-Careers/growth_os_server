// -------------------------------------------------------------------------
// EMPLOYEE SKILL DISPATCHER
// Maps { employee, skill } to the skill's executeSkill function.
// To add a new skill: import it and register it below.
// -------------------------------------------------------------------------

import { executeSkill as officeAdmin_signUpNoAccount } from './office_administrator/skills/sign_up_no_account/index.js';
import { executeSkill as leadGenExpert_analyseWebsite } from './lead_gen_expert/skills/analyse_website/index.js';
import { executeSkill as leadGenExpert_targetFinderTenLeads } from './lead_gen_expert/skills/target_finder_ten_leads/index.js';
import { executeSkill as leadGenExpert_targetFinder100Leads } from './lead_gen_expert/skills/target_finder_100_leads/index.js';
import { executeSkill as leadGenExpert_contactFinder } from './lead_gen_expert/skills/contact_finder/index.js';
import { executeSkill as leadGenExpert_enrichTarget } from './lead_gen_expert/skills/enrich_target/index.js';
import { executeSkill as leadGenExpert_itpRefiner } from './lead_gen_expert/skills/itp_refiner/index.js';
import { executeSkill as businessAnalyst_defineItp } from './business_analyst/skills/define_itp/index.js';
import { executeSkill as businessAnalyst_analyseCustomers } from './business_analyst/skills/analyse_customers/index.js';
import { executeSkill as emailCampaignManager_createNewSender } from './email_campaign_manager/skills/create_new_sender/index.js';
import { executeSkill as emailCampaignManager_createCampaign } from './email_campaign_manager/skills/create_campaign/index.js';
import { executeSkill as emailCampaignManager_launchCampaign } from './email_campaign_manager/skills/launch_campaign/index.js';
import { executeSkill as emailCampaignManager_syncToSmartlead } from './email_campaign_manager/skills/sync_to_smartlead/index.js';
import { broadcastSkillStatus } from '../intelligence/skill_status_broadcaster/index.js';
import { getSupabaseAdmin } from '../config/supabase.js';

// Skills that handle their own progress broadcasting — skip the initial persisted message
const skillsWithProgress = new Set([
  'lead_gen_expert/target_finder_ten_leads',
  'lead_gen_expert/target_finder_100_leads',
]);

// Skill-specific status messages shown to the user while running
// Shown in the chat feed (includes employee name)
const skillChatMessages = {
  'lead_gen_expert/target_finder_ten_leads': 'Belfort is searching for target companies... 0%',
  'lead_gen_expert/target_finder_100_leads': 'Belfort is expanding the target search...',
  'lead_gen_expert/contact_finder': 'Belfort is finding contact details...',
  'lead_gen_expert/enrich_target': 'Belfort is enriching target data...',
  'lead_gen_expert/itp_refiner': 'Belfort is refining your ideal target profile...',
  'lead_gen_expert/analyse_website': 'Belfort is analysing the website...',
  'business_analyst/define_itp': 'Warren is building your ideal target profile...',
  'business_analyst/analyse_customers': 'Warren is analysing your existing customers...',
  'email_campaign_manager/create_campaign': 'Draper is drafting your campaign...',
  'email_campaign_manager/create_new_sender': 'Draper is setting up your sender identity...',
  'email_campaign_manager/launch_campaign': 'Draper is launching your campaign...',
  'email_campaign_manager/sync_to_smartlead': 'Draper is syncing your campaign to Smartlead...',
};

// Shown in the employee sidebar (no name, short)
const skillSidebarMessages = {
  'lead_gen_expert/target_finder_ten_leads': 'Searching for targets...',
  'lead_gen_expert/target_finder_100_leads': 'Expanding target search...',
  'lead_gen_expert/contact_finder': 'Finding contacts...',
  'lead_gen_expert/enrich_target': 'Enriching target data...',
  'lead_gen_expert/itp_refiner': 'Refining target profile...',
  'lead_gen_expert/analyse_website': 'Analysing website...',
  'business_analyst/define_itp': 'Building target profile...',
  'business_analyst/analyse_customers': 'Analysing customers...',
  'email_campaign_manager/create_campaign': 'Drafting campaign...',
  'email_campaign_manager/create_new_sender': 'Setting up sender...',
  'email_campaign_manager/launch_campaign': 'Launching campaign...',
  'email_campaign_manager/sync_to_smartlead': 'Syncing to Smartlead...',
};

const skills = {
  office_administrator: {
    sign_up_no_account: officeAdmin_signUpNoAccount,
  },
  lead_gen_expert: {
    analyse_website: leadGenExpert_analyseWebsite,
    target_finder_ten_leads: leadGenExpert_targetFinderTenLeads,
    target_finder_100_leads: leadGenExpert_targetFinder100Leads,
    contact_finder: leadGenExpert_contactFinder,
    enrich_target: leadGenExpert_enrichTarget,
    itp_refiner: leadGenExpert_itpRefiner,
  },
  business_analyst: {
    define_itp: businessAnalyst_defineItp,
    analyse_customers: businessAnalyst_analyseCustomers,
  },
  email_campaign_manager: {
    create_new_sender: emailCampaignManager_createNewSender,
    create_campaign: emailCampaignManager_createCampaign,
    launch_campaign: emailCampaignManager_launchCampaign,
    sync_to_smartlead: emailCampaignManager_syncToSmartlead,
  },
};

export async function dispatchSkill(employee, skill, inputs) {
  const fn = skills[employee]?.[skill];
  if (!fn) throw new Error(`Unknown skill: ${employee}/${skill}`);

  const key = `${employee}/${skill}`;
  const chatMessage = skillChatMessages[key] ?? `Processing ${skill}...`;
  const sidebarMessage = skillSidebarMessages[key] ?? `Working...`;

  if (inputs.user_details_id) {
    // Idempotency guard: skip if this exact skill is already running (started within last 5 mins)
    const { data: currentUd } = await getSupabaseAdmin()
      .from('user_details').select('active_skill').eq('id', inputs.user_details_id).single();
    const as = currentUd?.active_skill;
    if (as && as.employee === employee && as.skill === skill && !as.failed) {
      const ageMs = Date.now() - new Date(as.started_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        console.log(`[dispatchSkill] ${key} already running (started ${Math.round(ageMs / 1000)}s ago) — skipping duplicate dispatch`);
        return;
      }
    }

    await broadcastSkillStatus(inputs.user_details_id, {
      employee,
      skill,
      status: 'running',
      message: chatMessage,
      sidebar_message: sidebarMessage,
      persist: !skillsWithProgress.has(key),
    });
    // Track active skill in DB so we can detect incomplete runs on return
    await getSupabaseAdmin()
      .from('user_details')
      .update({ active_skill: { employee, skill, started_at: new Date().toISOString() } })
      .eq('id', inputs.user_details_id);
  }

  try {
    const result = await fn(inputs);

    if (inputs.user_details_id) {
      await broadcastSkillStatus(inputs.user_details_id, {
        employee,
        skill,
        status: 'complete',
        message: null,
      });
      await getSupabaseAdmin()
        .from('user_details')
        .update({ active_skill: null })
        .eq('id', inputs.user_details_id);
    }

    return result;

  } catch (err) {
    if (inputs.user_details_id) {
      await broadcastSkillStatus(inputs.user_details_id, {
        employee,
        skill,
        status: 'complete',
        message: null,
      });
      await getSupabaseAdmin()
        .from('user_details')
        .update({ active_skill: { employee, skill, failed: true } })
        .eq('id', inputs.user_details_id);

      // Send a Watson error message so the user knows what happened
      const employeeName = {
        lead_gen_expert: 'Belfort',
        business_analyst: 'Warren',
        email_campaign_manager: 'Draper',
        office_administrator: 'Pepper',
      }[employee] ?? employee;

      const errorMessage = `Sorry — ${employeeName} ran into a problem with that task. These things happen occasionally. Want to try again, or is there something else I can help with?`;
      await getSupabaseAdmin()
        .from('messages')
        .insert({ user_details_id: inputs.user_details_id, message_body: errorMessage, is_agent: true });
    }
    throw err;
  }
}
