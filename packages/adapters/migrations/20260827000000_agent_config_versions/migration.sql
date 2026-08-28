-- Each mutation appends one immutable snapshot. Backfill the pre-versioning
-- state as version 1 before moving its payload out of the identity row.
CREATE TABLE agent_config_versions (
  agent_config_id text NOT NULL REFERENCES agent_configs(id),
  version integer NOT NULL,
  inference jsonb NOT NULL,
  system_prompt text NOT NULL,
  metadata jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (agent_config_id, version)
);

INSERT INTO agent_config_versions (
  agent_config_id,
  version,
  inference,
  system_prompt,
  metadata,
  updated_at
)
SELECT id, 1, inference, system_prompt, metadata, created_at
FROM agent_configs;

-- The identity row keeps only stable fields and a pointer used for atomic
-- optimistic-concurrency updates. Versioned payload has one source of truth.
ALTER TABLE agent_configs ADD COLUMN current_version integer NOT NULL DEFAULT 1;
ALTER TABLE agent_configs
  ALTER COLUMN current_version DROP DEFAULT,
  DROP COLUMN inference,
  DROP COLUMN system_prompt,
  DROP COLUMN metadata;

ALTER TABLE sessions
  ADD COLUMN agent_config_version integer NOT NULL DEFAULT 1;
ALTER TABLE sessions ALTER COLUMN agent_config_version DROP DEFAULT;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_agent_config_version_fk
  FOREIGN KEY (agent_config_id, agent_config_version)
  REFERENCES agent_config_versions (agent_config_id, version);
ALTER TABLE sessions DROP CONSTRAINT sessions_agent_config_id_fkey;
