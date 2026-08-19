-- Store schema, initial shape. Vanilla postgres only — transactions,
-- SKIP LOCKED, partial unique indexes; no extensions (see the design
-- doc's "Postgres targets": the same DDL must run on PGlite, compose,
-- k8s, Cloud SQL, PlanetScale-for-Postgres).

CREATE TABLE agent_configs (
  id text PRIMARY KEY,
  inference jsonb NOT NULL,
  system_prompt text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE env_configs (
  id text PRIMARY KEY,
  network jsonb NOT NULL,
  packages jsonb NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  agent_config_id text NOT NULL REFERENCES agent_configs(id),
  env_config_id text NOT NULL REFERENCES env_configs(id),
  -- The session's one workspace; null until the driver's first
  -- execute_tools claim registers it (Store.bindSandbox, set-if-null).
  sandbox_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL
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
