-- Tasks: a piece of work handed to an agent config (core/store.ts Task).
-- Its content becomes the first message of the session it starts. Today
-- a task starts in the transaction that creates it, so session_id is
-- never NULL; it is a column of its own, and not the task's identity,
-- because deferral will let a task wait — and a task cancelled while
-- waiting never gets a session.
CREATE TABLE tasks (
  namespace text NOT NULL,
  id text NOT NULL,
  agent_config_id text NOT NULL,
  -- Pinned when the task is created, not when its session starts: the
  -- task decided what runs it. Its session pins the same version.
  agent_config_version integer NOT NULL,
  -- The first message's content (core UserMessage content), kept on the
  -- task as well as in the log, so a task can say what it is before any
  -- session exists to log it.
  content jsonb NOT NULL,
  metadata jsonb,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, id),
  -- Same-namespace, structural, like sessions': the pinned version and
  -- the started session live in the task's own namespace.
  FOREIGN KEY (namespace, agent_config_id, agent_config_version)
    REFERENCES agent_config_versions (namespace, agent_config_id, version),
  FOREIGN KEY (namespace, session_id) REFERENCES sessions (namespace, id)
);
