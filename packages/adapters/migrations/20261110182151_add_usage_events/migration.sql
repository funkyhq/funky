-- Usage events (core UsageEvent): one row per committed assistant message
-- that carries usage, written by commitStep in the transaction that logs
-- the message, so the two exist together or not at all. The table is the
-- usage webhook's outbox: delivered_at stays NULL until a receiver has
-- taken the event, and the rows stay after it as the ledger of what was
-- reported. Quantities only — `usage` is the message's Usage verbatim,
-- and no price is ever stored.
CREATE TABLE usage_events (
  namespace text NOT NULL,
  session_id text NOT NULL,
  -- The event id: store-minted, and the receiver's idempotency key.
  id text NOT NULL,
  -- The assistant message's entry in the session's log.
  entry_id text NOT NULL,
  -- The session's pinned inference.provider, and the message's model.
  provider text NOT NULL,
  model text NOT NULL,
  usage jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  -- Delivery bookkeeping — adapter internals, not port vocabulary.
  -- NULL until a receiver accepted the event.
  delivered_at timestamptz,
  -- Failed deliveries so far: the retry backoff's input.
  attempts integer NOT NULL DEFAULT 0,
  -- When the event is next due for claimUsage: the committer's handoff
  -- at first, then a claimer's lease, then a failure's backoff.
  next_attempt_at timestamptz NOT NULL,
  -- The PK is the UsageEventRef verbatim, like work_items'.
  PRIMARY KEY (namespace, session_id, id),
  FOREIGN KEY (namespace, session_id) REFERENCES sessions (namespace, id)
);

-- One event per message, structurally.
CREATE UNIQUE INDEX usage_events_one_per_entry
  ON usage_events (namespace, session_id, entry_id);
-- The delivery scan's index: partial, so delivered history never enters
-- it, and the claim repeats the predicate verbatim. Namespace-free like
-- the work-item claim scan: delivery is the worker pool's cross-tenant
-- read.
CREATE INDEX usage_events_delivery_scan
  ON usage_events (next_attempt_at) WHERE delivered_at IS NULL;
