-- The store schema, whole. Vanilla postgres only — transactions, SKIP
-- LOCKED, partial unique indexes; no extensions (see the design doc's
-- "Postgres targets": the same DDL must run on PGlite, compose, k8s,
-- Cloud SQL, PlanetScale-for-Postgres).
--
-- One migration by choice, not by accident: nothing is deployed yet, so
-- the schema is still a description rather than a history. The moment a
-- database exists that this cannot be re-derived on, changes become
-- incremental migrations beside this file and it stops being edited.

-- namespace: the tenancy boundary (core/store.ts). Every table carries
-- it — the ownable rows because ownership is a fact on them, the
-- children (versions, entries, work items, pending inputs) as a copy
-- from their parent, made structural by composite FKs so it can never
-- diverge. No SQL DEFAULT — the caller supplies the value on every
-- create, so no resolution exists here at all.
--
-- Every table is keyed by its full path, namespace leading: point reads
-- arrive ref-scoped, so the PK serves them directly, and namespace is
-- the partition key the future PARTITION BY needs on every table (a
-- partitioned table's PK and unique indexes must include the partition
-- column — which is also why no bare-id UNIQUE exists anywhere).
CREATE TABLE agent_configs (
  namespace text NOT NULL,
  id text NOT NULL,
  -- Pointer to the latest snapshot in agent_config_versions. Bumping it
  -- is the update path's lock and its optional compare-and-set.
  current_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  -- The terminal state, set once and never cleared. NULL is not a
  -- toggle's off position — there is no unarchive — it is the absence
  -- of the archive event.
  archived_at timestamptz,
  PRIMARY KEY (namespace, id)
);

-- Every mutation appends one immutable snapshot, and a session pins one,
-- so a later update can never change a running session's behavior.
CREATE TABLE agent_config_versions (
  namespace text NOT NULL,
  agent_config_id text NOT NULL,
  version integer NOT NULL,
  inference jsonb NOT NULL,
  system_prompt text NOT NULL,
  metadata jsonb,
  updated_at timestamptz NOT NULL,
  -- The PK is the AgentConfigVersionRef verbatim.
  PRIMARY KEY (namespace, agent_config_id, version),
  FOREIGN KEY (namespace, agent_config_id) REFERENCES agent_configs (namespace, id)
);

CREATE TABLE env_configs (
  namespace text NOT NULL,
  id text NOT NULL,
  network jsonb NOT NULL,
  packages jsonb NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  -- Retires the recipe without deleting it. Existing sessions have their
  -- own copy; NULL means no archive event, and the mark is never cleared.
  archived_at timestamptz,
  PRIMARY KEY (namespace, id)
);

CREATE TABLE sessions (
  namespace text NOT NULL,
  id text NOT NULL,
  agent_config_id text NOT NULL,
  -- Resolved from the agent's latest version at session creation; the
  -- composite FK below makes that behavior snapshot durable.
  agent_config_version integer NOT NULL,
  env_config_id text NOT NULL,
  -- The env recipe resolved at create (core/store.ts EnvConfigSnapshot).
  -- Env configs update in place, so there is no version to pin: the copy
  -- is what makes a session's world deterministic. Provisioning reads
  -- this; env_config_id stays for provenance, never for a reload.
  env_config_snapshot jsonb NOT NULL,
  -- The session's one workspace; null until the driver's first
  -- execute_tools claim registers it (Store.bindSandbox, set-if-null).
  sandbox_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  -- Terminal lifecycle mark. The history stays readable, but the
  -- session accepts no new client writes; NULL means active.
  archived_at timestamptz,
  PRIMARY KEY (namespace, id),
  -- Same-namespace, structural, on both references: the pinned version
  -- and the env recipe must live in the session's own namespace.
  FOREIGN KEY (namespace, agent_config_id, agent_config_version)
    REFERENCES agent_config_versions (namespace, agent_config_id, version),
  FOREIGN KEY (namespace, env_config_id) REFERENCES env_configs (namespace, id)
);

-- The list scan's index (Store.listSessions). The PK's second column is a
-- random id, so it cannot order by time: without this, a page reads and
-- sorts the namespace's whole history to return one screenful, and the
-- keyset cursor buys nothing. Sessions is the one listed table that grows
-- without bound — the configs beside it are a small fixed set, which is
-- why only this one carries the index. Ascending by choice: a leading
-- equality on namespace lets the newest-first order walk it backwards, so
-- one index serves both directions.
CREATE INDEX sessions_list_scan ON sessions (namespace, created_at, id);
-- The default list omits archived rows, so it gets its own partial index —
-- the active scan stays bounded once archived history dominates. The full
-- index above serves includeArchived=true; the cursor is a PK lookup that
-- never filters on archived_at, so paging survives an archive mid-walk.
CREATE INDEX sessions_active_list_scan
  ON sessions (namespace, created_at, id) WHERE archived_at IS NULL;

CREATE TABLE session_entries (
  namespace text NOT NULL,
  session_id text NOT NULL,
  seq integer NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (namespace, session_id, seq),
  FOREIGN KEY (namespace, session_id) REFERENCES sessions (namespace, id)
);

CREATE TABLE work_items (
  namespace text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  lease_token text,
  lease_expires_at timestamptz,
  lease_ms integer,
  -- Times claimed (claimItem increments). The driver's at-most-once
  -- guard for tool side effects keys on attempt > 1.
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  -- The PK is the WorkItemRef verbatim — the full path to the row; the
  -- (namespace, session_id) prefix indexes the session-scoped scans.
  PRIMARY KEY (namespace, session_id, id),
  FOREIGN KEY (namespace, session_id) REFERENCES sessions (namespace, id)
);

-- The one-open-item invariant: at most one non-done item per session.
-- Carries the partition key like every unique index here; per-session
-- uniqueness still holds because session ids are store-minted UUIDs.
CREATE UNIQUE INDEX work_items_one_open_per_session
  ON work_items (namespace, session_id) WHERE status <> 'done';
-- The claim scan's index: partial, so the unbounded done majority never
-- enters it — the index stays sized to live work, and a poll is one
-- ordered walk that stops at the first claimable row. The claim query
-- repeats this exact predicate so the planner's implication proof is
-- trivial. Deliberately namespace-free: the claim scan is the worker
-- pool's cross-tenant read.
CREATE INDEX work_items_claim_scan
  ON work_items (created_at) WHERE status <> 'done';

CREATE TABLE pending_inputs (
  namespace text NOT NULL,
  session_id text NOT NULL,
  -- The port-level name — what consumeInputs targets. In the PK, so
  -- an input id is unique within its session by construction.
  id text NOT NULL,
  -- Drain order — arrival order even under equal timestamps. A global
  -- bigserial, gappy and never per-session dense: plumbing, not
  -- contract. Reads scan the PK prefix and order by it.
  ord bigserial,
  message jsonb NOT NULL,
  arrived_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, session_id, id),
  FOREIGN KEY (namespace, session_id) REFERENCES sessions (namespace, id)
);
