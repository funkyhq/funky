-- Usage events get a kind (core UsageEvent is a union on it):
-- - 'tokens': one assistant message's usage — entry_id, provider, model
--   and usage, as every row before this migration was;
-- - 'runtime': one work item's span, recorded by the commit that closes
--   the item — item_id, created_at (the item's), finished_at,
--   duration_ms, and the sandbox size the session's pinned config asks
--   for, DEFAULT_RESOURCES filling in what it leaves out.
-- Existing rows become 'tokens' through the default, which then goes, so
-- every insert names its kind. Quantities only, as before: no price.
ALTER TABLE usage_events ADD COLUMN kind text NOT NULL DEFAULT 'tokens';
ALTER TABLE usage_events ALTER COLUMN kind DROP DEFAULT;

-- A tokens event's columns are NULL on a runtime event, and the other
-- way round; the check below keeps each kind's own columns filled.
ALTER TABLE usage_events ALTER COLUMN entry_id DROP NOT NULL;
ALTER TABLE usage_events ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE usage_events ALTER COLUMN model DROP NOT NULL;
ALTER TABLE usage_events ALTER COLUMN usage DROP NOT NULL;

-- The work item a runtime event measures, and its end: finished_at is
-- the item's, set by the same commit. created_at is the item's start.
ALTER TABLE usage_events ADD COLUMN item_id text;
ALTER TABLE usage_events ADD COLUMN finished_at timestamptz;
-- finished_at − created_at in ms, clamped at 0: the two instants can
-- come from different hosts' clocks.
ALTER TABLE usage_events ADD COLUMN duration_ms bigint;
-- The pinned config's resources with the defaults filled in.
ALTER TABLE usage_events ADD COLUMN cpu_count integer;
ALTER TABLE usage_events ADD COLUMN memory_mb integer;

ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_fields CHECK (
  (kind = 'tokens'
    AND entry_id IS NOT NULL AND provider IS NOT NULL
    AND model IS NOT NULL AND usage IS NOT NULL)
  OR (kind = 'runtime'
    AND item_id IS NOT NULL AND finished_at IS NOT NULL AND duration_ms IS NOT NULL
    AND cpu_count IS NOT NULL AND memory_mb IS NOT NULL)
);

ALTER TABLE usage_events ADD CONSTRAINT usage_events_item_fk
  FOREIGN KEY (namespace, session_id, item_id) REFERENCES work_items (namespace, session_id, id);

-- One runtime event per item, structurally, as one tokens event per
-- entry (usage_events_one_per_entry; a NULL key never collides).
CREATE UNIQUE INDEX usage_events_one_per_item
  ON usage_events (namespace, session_id, item_id);
