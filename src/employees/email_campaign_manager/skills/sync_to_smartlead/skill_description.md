# Sync to Smartlead

Pushes a GrowthOS campaign to Smartlead for automated email sending.

## Process
1. Create campaign in Smartlead
2. Save email sequences (initial + follow-ups)
3. Set schedule and settings
4. Attach email account (create in Smartlead if needed)
5. Push leads from campaign_contacts
6. (Production only) Activate campaign

## Inputs
- campaign_id (uuid)
- user_details_id (text)
