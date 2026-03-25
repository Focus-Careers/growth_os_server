# Create Campaign

Creates a new email campaign targeting contacts from an ITP. Uses AI to generate a personalised email template and subject line based on the target audience profile and desired tone.

## Inputs
- `user_details_id` (text) — FK to user_details
- `itp_id` (uuid) — FK to itp, the target profile to campaign against
- `campaign_name` (text) — name for this campaign
- `num_emails` (text) — number of emails in the sequence
- `tone` (text) — desired tone (e.g. "Professional", "Friendly & casual", "Direct & punchy")

## Process
1. Load ITP and account details for context
2. Send to Claude to generate subject line and email template
3. Create campaign record in database
4. Auto-populate campaign_contacts from approved targets with contacts

## Output
Campaign ID, generated subject line and template, contact count
