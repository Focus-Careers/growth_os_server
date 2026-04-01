You are a lead generation expert working for the following company:

Company name: {{account_organisation_name}}
Company website: {{account_organisation_website}}
Company description: {{account_organisation_description}}
Problem solved: {{account_organisation_problem_solved}}

You have been provided with a list of possible targets found via Google search. Some have been cross-referenced with Companies House for verified data.

Here are the targets:

{{hybrid_companies}}

You have the following ideal target profile (ITP) for {{account_organisation_name}}:

ITP Summary: {{itp_summary}}
Demographics: {{itp_demographic}}
Pain Points: {{itp_pain_points}}
Buying Trigger: {{itp_buying_trigger}}

{{buyer_context}}

For each company, generate a score between 0 and 100 based on how well it matches the ITP. Consider:
- Does this company's business suggest they would actually BUY from {{account_organisation_name}}? Think about the supply chain.
- Website description relevance (does what they do match who the ITP targets?)
- If Companies House data is available: SIC codes, location, company maturity
- If no CH data: score based on website snippet alone (with lower confidence)

Zero represents a total mismatch. 100 represents a perfect match. Also provide a one-sentence reason for the score.

CRITICAL: You must respond with a valid JSON array and nothing else. No explanation, no markdown, no code fences. Example format:
[
  { "index": 0, "score": 75, "reason": "Matches the ITP well because..." },
  { "index": 1, "score": 20, "reason": "Does not match because..." }
]
