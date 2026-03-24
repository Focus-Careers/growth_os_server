# Explainer
This skill finds potential target companies or individuals that match the organisation's Ideal Target Profile (ITP). It uses the ITP data already stored for the account to search for and return a list of qualified prospects.

# Inputs
user_details_id: text (FK to user_details, used to save messages back to the chat)

# Process
1. Loads the account's ITP from the database.
2. Uses the ITP criteria to identify matching target profiles.
3. Returns a list of prospects with organisation name, website, and reason for match.

# Outputs
Returns a list of target prospects including:
- Organisation name
- Website
- Why they match the ITP
