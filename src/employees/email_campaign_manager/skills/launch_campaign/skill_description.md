# Launch Campaign

Activates a campaign by setting its sender and status to active, then triggers target_finder_100_leads to populate the campaign with targets.

## Inputs
- `user_details_id` (text) — FK to user_details
- `campaign_id` (uuid) — FK to campaigns
- `sender_id` (uuid) — FK to senders

## Process
1. Update campaign with sender_id and status = active
2. Trigger target_finder_100_leads to fill campaign with targets

## Output
Campaign ID and active status
