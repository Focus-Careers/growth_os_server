# growth_os_server

The GrowthOS API: Express on Node, hosted on Railway. It runs Watson's chat routing, the scripted flows (`src/mobilisations/`), the AI employees' skills (`src/employees/`), lead generation, Smartlead sync, webhooks and cron jobs.

## Read the wiki first

The GrowthOS wiki in Notion is the source for how and why the product works:
https://app.notion.com/p/40dcea71a7918198b954fd24fc9f870e

Most useful pages for this repo:
- Start Here: https://app.notion.com/p/40dcea71a79181d89a7ef6658081dc82
- Repos and Code Map: https://app.notion.com/p/40dcea71a7918147a02aeb465a2e5c38
- Chat, Mobilisations and Skills: https://app.notion.com/p/40dcea71a791817c9bace8004e25b750
- Lead Generation Pipeline: https://app.notion.com/p/40dcea71a7918162a74bc05aa2e08334
- Email Sending and Tracking: https://app.notion.com/p/40dcea71a79181a0a346da022cc47a04
- Environment Variables: https://app.notion.com/p/40dcea71a791812f93a0ef07a0f45ab4
- Decisions: https://app.notion.com/p/40dcea71a79181e08a91d891bb1d773f

## Working rules

- A push to `main` deploys to production on Railway. Work on a branch and merge only when checked.
- There is no staging environment. Local development uses the production Supabase project, so every write is real.
- A local server starts the cron jobs (hourly send reconciliation and scheduled target-finder runs) against production. Stop it when you are not using it.
- Never point `WEBHOOK_BASE_URL` at your machine while syncing campaigns or re-registering webhooks: it re-points production Smartlead webhooks.
- The server runs as one instance. Cron schedules and the Stop registry live in memory.
- There are no automated tests. Check changes by hand before merging.
- Never commit `.env` files or print secret values. Variable names are listed on the Environment Variables page.
- Model names live in `src/config/models.js` and can be overridden by environment variables. Change models there, not at call sites.
- Database migrations live in the growth_os_app repo (`supabase/migrations`), not here.
- When behaviour changes, update the matching wiki page and its "Last checked" date.
