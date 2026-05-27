# Lead Generation Complete — Message Instructions

Your lead generation expert has finished populating the campaign. The output fields are:
- `approved_leads` — number of approved companies/leads for this target profile
- `contacts_loaded` — number of contacts (people) loaded into the campaign. May be null if this run wasn't tied to a campaign.
- `itp_name` — the name of the ideal target profile (use this, NOT any ID)

Write a short message:
- Report BOTH numbers, clearly distinguished: contacts are the people, approved leads are the companies they came from.
- Example phrasing: "Loaded {contacts_loaded} contacts from {approved_leads} approved companies for {itp_name} — your campaign is ready to launch."
- If `contacts_loaded` is null or 0, just report the approved leads (e.g. "{approved_leads} approved companies for {itp_name}") and don't mention contacts.
- Never show a raw ID or UUID. Always use `itp_name`. If `itp_name` is missing, just say "your target profile".
- Keep it to one or two sentences. No greeting, no re-introduction.
