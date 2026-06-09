# Automated Mailbox Provisioning via SmartSenders

Full-stack feature enabling automatic domain registration, mailbox creation, and warmup through SmartSenders API integration. Includes provisioning workflow, multi-sender campaign support, and production-ready UI components with real-time status tracking.

## Features

- **SmartSenders API wrapper** — 0.5-1.5 hrs (high risk) — Simple wrapper but depends on resolving API entitlement and credential handling unknowns
- **Database migrations and schema changes** — 1-2 hrs (medium risk) — Multiple table changes with junction table and state machine fields - integration with existing schema
- **Domain suggestion and persona utilities** — 0.5-1 hrs (low risk) — Straightforward string manipulation and generation logic
- **Provisioning API endpoints** — 1-2.5 hrs (medium risk) — 4 endpoints with validation, error handling, and integration with existing auth patterns
- **Provisioning poller worker** — 2-4 hrs (high risk) — Complex async state machine with 24-48h polling cycle, heavily dependent on API payload format
- **Multi-sender campaign support** — 1.5-3 hrs (medium risk) — Requires modifying existing sync_to_smartlead logic and junction table relationships
- **useProvisioning React hook** — 0.5-1.5 hrs (low risk) — Standard React data fetching with real-time updates via Supabase
- **Provisioning wizard UI** — 3-5 hrs (medium risk) — Production-ready 4-step flow with async status tracking, polish required for core value prop
- **Campaign multi-sender UI** — 2-4 hrs (medium risk) — Extending large CampaignManager component, sender pills, capacity indicators - production quality
- **Suppression/unsubscribe table** — 0.5-1.5 hrs (low risk) — Straightforward table creation and pre-send validation logic

### Risks
- SmartSenders API may require special entitlement beyond standard API access - potential project blocker
- Order completion payload format unknown - could require significant poller architecture changes if SMTP credentials not included
- SmartSenders API edge cases likely underdocumented based on Smartlead track record - budget for trial-and-error discovery
- Complex state machine polling over 24-48h cycle with potential failure modes that are hard to test locally
- Extending 800-line CampaignManager component increases risk of breaking existing functionality
### Start with
SmartSenders API wrapper - resolves the critical unknowns around API entitlement and credential handling that affect the entire project architecture
### Time estimates
- Optimistic: 10.2h (1.3 days)
- Realistic: 16.9h (2.1 days)
- Pessimistic: 31.5h (3.9 days)

## Scoper Integration

This project is tracked by Scoper. Development activity is automatically logged via hooks.

- Project key: scoper_492acbfa2e724a50
- Endpoint: http://localhost:5173/api/hooks/task
