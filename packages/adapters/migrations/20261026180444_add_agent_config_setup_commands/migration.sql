-- Setup commands: shell commands that finish a session's sandbox after its
-- packages install (core SetupCommands). Like network, packages and
-- credentials, required at create and carried forward by every update, so
-- each snapshot is whole. Versions saved before this ran had none, which
-- is []; the default fills them in and is then dropped, so a write that
-- leaves the column out is refused rather than silently given [].
ALTER TABLE agent_config_versions ADD COLUMN setup_commands jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_config_versions ALTER COLUMN setup_commands DROP DEFAULT;
