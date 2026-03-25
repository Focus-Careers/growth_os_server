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
import { executeSkill as businessAnalyst_defineItp } from './business_analyst/skills/define_itp/index.js';
import { executeSkill as emailCampaignManager_createNewSender } from './email_campaign_manager/skills/create_new_sender/index.js';
import { executeSkill as emailCampaignManager_createCampaign } from './email_campaign_manager/skills/create_campaign/index.js';

const skills = {
  office_administrator: {
    sign_up_no_account: officeAdmin_signUpNoAccount,
  },
  lead_gen_expert: {
    analyse_website: leadGenExpert_analyseWebsite,
    target_finder_ten_leads: leadGenExpert_targetFinderTenLeads,
    target_finder_100_leads: leadGenExpert_targetFinder100Leads,
    contact_finder: leadGenExpert_contactFinder,
  },
  business_analyst: {
    define_itp: businessAnalyst_defineItp,
  },
  email_campaign_manager: {
    create_new_sender: emailCampaignManager_createNewSender,
    create_campaign: emailCampaignManager_createCampaign,
  },
};

export async function dispatchSkill(employee, skill, inputs) {
  const fn = skills[employee]?.[skill];
  if (!fn) throw new Error(`Unknown skill: ${employee}/${skill}`);
  return fn(inputs);
}
