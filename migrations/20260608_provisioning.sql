-- =============================================================================
-- Automated Mailbox Provisioning via SmartSenders
-- =============================================================================
-- 1. provisioning_orders     — state machine for SmartSenders orders
-- 2. senders                  — extend with provisioning_order_id, connection_type
-- 3. campaign_senders         — junction table for multi-sender campaigns
-- 4. suppression_list         — per-account unsubscribe / pre-send block list
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. provisioning_orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provisioning_orders (
  id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID            NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  smartsenders_order_id   TEXT            UNIQUE,
  state                   TEXT            NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','ORDER_PLACED','PROVISIONING','ACTIVE','ORDER_FAILED','PROVISIONING_STALLED','ROTATING','RETIRED')),
  tier                    TEXT,
  primary_domain          TEXT,
  selected_domain         TEXT,
  num_domains             INT             NOT NULL DEFAULT 1,
  num_mailboxes           INT             NOT NULL DEFAULT 2,
  vendor_id               TEXT,
  pre_warmed              BOOLEAN         NOT NULL DEFAULT FALSE,
  order_payload           JSONB,
  order_response          JSONB,
  last_poll_at            TIMESTAMPTZ,
  last_error              TEXT,
  warmup_started_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_provisioning_orders_account_id
  ON public.provisioning_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_provisioning_orders_state
  ON public.provisioning_orders(state)
  WHERE state IN ('ORDER_PLACED','PROVISIONING');

-- ---------------------------------------------------------------------------
-- 2. senders — extend with provisioning fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.senders
  ADD COLUMN IF NOT EXISTS provisioning_order_id UUID
    REFERENCES public.provisioning_orders(id) ON DELETE SET NULL;
ALTER TABLE public.senders
  ADD COLUMN IF NOT EXISTS connection_type TEXT
    NOT NULL DEFAULT 'manual'
    CHECK (connection_type IN ('manual','provisioned'));
ALTER TABLE public.senders
  ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_senders_provisioning_order_id
  ON public.senders(provisioning_order_id);

-- ---------------------------------------------------------------------------
-- 3. campaign_senders — junction for multi-sender campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_senders (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID         NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  sender_id  UUID         NOT NULL REFERENCES public.senders(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, sender_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_senders_campaign_id
  ON public.campaign_senders(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_senders_sender_id
  ON public.campaign_senders(sender_id);

-- Back-fill existing 1:1 campaign.sender_id rows into the junction table
INSERT INTO public.campaign_senders (campaign_id, sender_id)
SELECT id, sender_id FROM public.campaigns
WHERE sender_id IS NOT NULL
ON CONFLICT (campaign_id, sender_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. suppression_list — pre-send block list (unsubscribes, bounces, hard blocks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suppression_list (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID         REFERENCES public.account(id) ON DELETE CASCADE,
  email       TEXT         NOT NULL,
  reason      TEXT         NOT NULL DEFAULT 'unsubscribed'
    CHECK (reason IN ('unsubscribed','bounced','complained','manual','invalid')),
  source      TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, email)
);

CREATE INDEX IF NOT EXISTS idx_suppression_list_email
  ON public.suppression_list(email);
CREATE INDEX IF NOT EXISTS idx_suppression_list_account_email
  ON public.suppression_list(account_id, email);
