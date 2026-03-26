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
import { executeSkill as emailCampaignManager_createNewSender } from './email_campaign_manager/skills/create_new_sender/index.js';
import { executeSkill as emailCampaignManager_createCampaign } from './email_campaign_manager/skills/create_campaign/index.js';
import { executeSkill as emailCampaignManager_launchCampaign } from './email_campaign_manager/skills/launch_campaign/index.js';
import { broadcastSkillStatus } from '../intelligence/skill_status_broadcaster/index.js';

// Skill-specific status messages shown to the user while running
const skillStatusMessages = {
  'lead_gen_expert/target_finder_ten_leads': 'Belfort is searching the web for target companies...',
  'lead_gen_expert/target_finder_100_leads': 'Belfort is expanding the target search...',
  'lead_gen_expert/contact_finder': 'Belfort is finding contact details...',
  'lead_gen_expert/enrich_target': 'Belfort is enriching target data...',
  'lead_gen_expert/itp_refiner': 'Belfort is refining your ideal target profile...',
  'lead_gen_expert/analyse_website': 'Belfort is analysing the website...',
  'business_analyst/define_itp': 'Warren is building your ideal target profile...',
  'email_campaign_manager/create_campaign': 'Draper is drafting your campaign...',
  'email_campaign_manager/create_new_sender': 'Draper is setting up your sender identity...',
  'email_campaign_manager/launch_campaign': 'Draper is launching your campaign...',
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
  },
  email_campaign_manager: {
    create_new_sender: emailCampaignManager_createNewSender,
    create_campaign: emailCampaignManager_createCampaign,
    launch_campaign: emailCampaignManager_launchCampaign,
  },
};

export async function dispatchSkill(employee, skill, inputs) {
  const fn = skills[employee]?.[skill];
  if (!fn) throw new Error(`Unknown skill: ${employee}/${skill}`);

  const key = `${employee}/${skill}`;
  const statusMessage = skillStatusMessages[key] ?? `Processing ${skill}...`;

  if (inputs.user_details_id) {
    await broadcastSkillStatus(inputs.user_details_id, {
      employee,
      skill,
      status: 'running',
      message: statusMessage,
    });
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
    }
    throw err;
  }
}
