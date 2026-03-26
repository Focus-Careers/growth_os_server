# Website People Extraction

You will be given text scraped from a company's website. Extract any people mentioned along with their details.

For each person found, extract:
- **first_name**: Their first name
- **last_name**: Their last name (null if not found)
- **email**: Their email address (null if not found on the page)
- **role**: Their job title or role (null if not clear)
- **phone**: Their direct phone number (null if not found)
- **linkedin**: Their LinkedIn URL (null if not found)

Only include people who appear to actually work at this company. Ignore:
- Generic contact emails like info@, hello@, sales@, support@ (unless no other contacts are found)
- People mentioned in testimonials, case studies, or news articles
- Social media handles that aren't LinkedIn

Return a JSON array of objects. If no people are found, return an empty array [].

Return ONLY valid JSON. No markdown, no code fences, no explanation.

Example output:
[
  { "first_name": "John", "last_name": "Smith", "email": "john@example.com", "role": "Managing Director", "phone": null, "linkedin": null },
  { "first_name": "Sarah", "last_name": "Jones", "email": null, "role": "Operations Manager", "phone": null, "linkedin": "https://linkedin.com/in/sarahjones" }
]
