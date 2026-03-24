# Explainer
This skill analyses an organisation's website to extract key information about the business, its products/services, and its likely target audience.

# Inputs
website: text (URL of the organisation's website)
user_details_id: text (FK to user_details, used to save messages back to the chat)

# Process
1. Fetches and reads the content of the provided website URL.
2. Uses an AI model to analyse the content and extract key business information.
3. Saves the analysis as agent messages back to the user's chat.

# Outputs
Returns a summary of the website analysis including:
- Organisation description
- Key products/services
- Likely target audience
