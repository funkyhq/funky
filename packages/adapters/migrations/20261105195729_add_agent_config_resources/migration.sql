-- Resources: the vCPUs and memory a session's sandbox gets (core
-- Resources). Like network, packages, credentials and setup commands,
-- required at create and carried forward by every update, so each
-- snapshot is whole. Versions saved before this ran asked for no size,
-- which is {}: the provider's default. The default fills them in and is
-- then dropped, so a write that leaves the column out is refused rather
-- than silently given {}.
ALTER TABLE agent_config_versions ADD COLUMN resources jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_config_versions ALTER COLUMN resources DROP DEFAULT;
