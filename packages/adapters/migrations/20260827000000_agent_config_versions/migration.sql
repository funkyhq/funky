-- Agent configs now follow UpdateAgent-style optimistic concurrency. Existing
-- configs become version 1 and start with updated_at equal to created_at.
ALTER TABLE agent_configs ADD COLUMN version integer;
ALTER TABLE agent_configs ADD COLUMN updated_at timestamptz;

UPDATE agent_configs SET version = 1 WHERE version IS NULL;
UPDATE agent_configs SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE agent_configs ALTER COLUMN version SET NOT NULL;
ALTER TABLE agent_configs ALTER COLUMN updated_at SET NOT NULL;

-- Each mutation appends one immutable snapshot. Backfill the pre-versioning
-- state as version 1 before sessions begin referencing concrete versions.
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
SELECT id, version, inference, system_prompt, metadata, updated_at
FROM agent_configs;

ALTER TABLE sessions ADD COLUMN agent_config_version integer;
UPDATE sessions SET agent_config_version = 1 WHERE agent_config_version IS NULL;
ALTER TABLE sessions ALTER COLUMN agent_config_version SET NOT NULL;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_agent_config_version_fk
  FOREIGN KEY (agent_config_id, agent_config_version)
  REFERENCES agent_config_versions (agent_config_id, version);
