-- The store schema, whole. Vanilla postgres only — transactions, SKIP
-- LOCKED, partial unique indexes; no extensions (see the design doc's
-- "Postgres targets": the same DDL must run on PGlite, compose, k8s,
-- Cloud SQL, PlanetScale-for-Postgres).
--
-- One migration by choice, not by accident: nothing is deployed yet, so
-- the schema is still a description rather than a history. The moment a
-- database exists that this cannot be re-derived on, changes become
-- incremental migrations beside this file and it stops being edited.

-- namespace: the tenancy boundary (core/store.ts). Only the three
-- ownable row types carry it; children derive theirs through
-- session_id. No SQL DEFAULT — the adapter materializes the value, so
-- the resolution lives in exactly one place.
CREATE TABLE agent_configs (
  id text PRIMARY KEY,
  namespace text NOT NULL,
  -- Pointer to the latest snapshot in agent_config_versions. Bumping it
  -- is the update path's lock and its optional compare-and-set.
  current_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  -- The terminal state, set once and never cleared. NULL is not a
  -- toggle's off position — there is no unarchive — it is the absence
  -- of the archive event.
  archived_at timestamptz
);

-- Every mutation appends one immutable snapshot, and a session pins one,
-- so a later update can never change a running session's behavior.
CREATE TABLE agent_config_versions (
  agent_config_id text NOT NULL REFERENCES agent_configs(id),
  version integer NOT NULL,
  inference jsonb NOT NULL,
  system_prompt text NOT NULL,
  metadata jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (agent_config_id, version)
);

CREATE TABLE env_configs (
  id text PRIMARY KEY,
  network jsonb NOT NULL,
  packages jsonb NOT NULL,
  namespace text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  agent_config_id text NOT NULL,
  -- Resolved from the agent's latest version at session creation; the
  -- composite FK below makes that behavior snapshot durable.
  agent_config_version integer NOT NULL,
  env_config_id text NOT NULL REFERENCES env_configs(id),
  namespace text NOT NULL,
  -- The session's one workspace; null until the driver's first
  -- execute_tools claim registers it (Store.bindSandbox, set-if-null).
  sandbox_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (agent_config_id, agent_config_version)
    REFERENCES agent_config_versions (agent_config_id, version)
);

CREATE TABLE session_entries (
  session_id text NOT NULL REFERENCES sessions(id),
  seq integer NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE work_items (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  type text NOT NULL,
  status text NOT NULL,
  lease_token text,
  lease_expires_at timestamptz,
  lease_ms integer,
  -- Times claimed (claimItem increments). The driver's at-most-once
  -- guard for tool side effects keys on attempt > 1.
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

-- The one-open-item invariant: at most one non-done item per session.
CREATE UNIQUE INDEX work_items_one_open_per_session
  ON work_items (session_id) WHERE status <> 'done';
CREATE INDEX work_items_claim_scan ON work_items (status, created_at);

CREATE TABLE pending_inputs (
  session_id text NOT NULL REFERENCES sessions(id),
  ord bigserial,
  id text NOT NULL UNIQUE,
  message jsonb NOT NULL,
  arrived_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, ord)
);
