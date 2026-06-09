-- Creates a per-event log for Smartlead webhook events.
-- Needed because campaign_contacts holds only current status (one row per contact),
-- so multi-sequence sends (e.g. seq1 + seq2 to the same lead) were invisible.

CREATE TABLE IF NOT EXISTS campaign_contact_events (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id      UUID        NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
  contact_id       UUID        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,  -- 'sent', 'opened', 'replied', 'bounced', 'unsubscribed'
  sequence_number  INT,
  event_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_contact_events_campaign_contact_idx
  ON campaign_contact_events (campaign_id, contact_id);

CREATE INDEX IF NOT EXISTS campaign_contact_events_campaign_type_idx
  ON campaign_contact_events (campaign_id, event_type);

ALTER TABLE campaign_contact_events ENABLE ROW LEVEL SECURITY;
