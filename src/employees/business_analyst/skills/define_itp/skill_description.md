# Explainer
This skill analyses an organisation's details and defines their Ideal Target Profile (ITP) — a precise description of the type of customer they should be marketing to.

# Inputs
organisation_name: text
organisation_website: text
description: text
problem_solved: text
user_details_id: text (FK to user_details, used to save messages back to the chat)

# Process
1. Reviews the organisation's details passed as inputs.
2. Uses an AI model with a structured prompt to define the ideal target profile.
3. Returns the ITP as structured JSON.

# Outputs
Returns a structured ideal target profile including target audience description, demographic indicators, and key pain points.
