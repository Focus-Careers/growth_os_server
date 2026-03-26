# Enrich Target

Enriches a target company with data from multiple sources: Apollo company enrichment, website scraping (Cheerio), Claude people extraction, and Apollo people reveal.

## Inputs
- `target_id` (uuid) — FK to targets
- `user_details_id` (text) — for logging
- `silent` (boolean, default true) — skip skill output broadcasting

## Process
1. Apollo company enrichment — get company details, socials, employee count
2. Website scrape — homepage + common paths, extract text and emails
3. Claude extraction — find people names, roles, emails from scraped text
4. Apollo people reveal — for people with names but no email, reveal via Apollo
5. Save contacts to database with source tracking

## Output
List of saved contacts
