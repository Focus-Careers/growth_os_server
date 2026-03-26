# Explainer
This skill finds key contacts at target lead organisations, identifying decision-makers and relevant personnel who may be involved in purchasing decisions.

# Inputs
user_details_id: text (FK to user_details, used to save messages back to the chat)
lead_id: text (FK to targets, the organisation to find contacts for)

# Process
1. Retrieves the lead's organisation details.
2. Searches for relevant contacts at the organisation.
3. Saves discovered contacts to the contacts table.

# Outputs
Returns a list of contacts found at the organisation including name, email, and role.
