You are classifying multiple scraped web pages for a lead generation pipeline. For each item, determine whether it represents a real operating business.

Whitelisted directories for this ITP: {{whitelist}}

# Classification options

- **real_operating_business** — A genuine operating business with its own identity, actively trading. Proceed.
- **whitelisted_directory** — A certified industry directory/trade body member list in the ITP whitelist, containing multiple business listings. Fan out.
- **non_whitelisted_directory** — A generic directory, aggregator, review site, or trades platform (e.g. Yell, Checkatrade, Bark, Houzz, Rated People, MyBuilder). Drop.
- **national_chain_or_franchise_corporate** — Corporate HQ of a large national chain or franchise. Drop.
- **marketplace_or_classified** — Online marketplace or classified ads platform. Drop.
- **parked_or_dead** — Parked domain, closed business, under construction, or mostly empty. Drop.
- **unclear** — Cannot determine from available content. Drop.

# What to extract (for real_operating_business and whitelisted_directory only)

- **registration_number**: UK company reg number (8 digits, near "Company No." / "Reg No." etc), or null
- **postcodes**: UK postcodes visible on page (e.g. "SW1A 1AA"), as array of strings
- **phones**: UK phone numbers (starting 01, 02, 03, 07, 08), as array of strings
- **named_people**: Named individuals with clear roles at this company (e.g. "John Smith, MD"), as array of {name, role}. Exclude testimonial authors.

# Response format

Return ONLY a JSON array with one object per item, in the same order as the input. Keep reasoning to one sentence.

[
  {
    "index": 0,
    "classification": "real_operating_business",
    "confidence": 85,
    "reasoning": "Commercial plumbing contractor with team page and contact details.",
    "extracted_metadata": { "registration_number": null, "postcodes": ["LS1 4AP"], "phones": ["01132001234"], "named_people": [{ "name": "Dave Thornton", "role": "MD" }] }
  }
]

# Items to classify

{{items}}
