import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const init = readFileSync(
  new URL("../migrations/20260820000000_init/migration.sql", import.meta.url),
  "utf8",
);
const agentConfigVersions = readFileSync(
  new URL("../migrations/20260827000000_agent_config_versions/migration.sql", import.meta.url),
  "utf8",
);

describe("store migrations", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("backfills version and updated_at for existing agent configs", async () => {
    client = new PGlite();
    await client.exec(init);
    await client.query(
      `INSERT INTO agent_configs
        (id, inference, system_prompt, namespace, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["existing", { provider: "fake", model: "m" }, "s", "default", null, "2026-08-20T12:00:00Z"],
    );
    await client.query(
      `INSERT INTO env_configs
        (id, network, packages, namespace, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["env", { type: "unrestricted" }, {}, "default", null, "2026-08-20T12:00:00Z"],
    );
    await client.query(
      `INSERT INTO sessions
        (id, agent_config_id, env_config_id, namespace, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["session", "existing", "env", "default", null, "2026-08-20T12:00:00Z"],
    );

    await client.exec(agentConfigVersions);

    const result = await client.query<{
      version: number;
      created_at: Date;
      updated_at: Date;
    }>("SELECT version, created_at, updated_at FROM agent_configs WHERE id = 'existing'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.version).toBe(1);
    expect(result.rows[0]?.updated_at).toEqual(result.rows[0]?.created_at);

    const versions = await client.query<{
      agent_config_id: string;
      version: number;
      system_prompt: string;
    }>("SELECT agent_config_id, version, system_prompt FROM agent_config_versions");
    expect(versions.rows).toEqual([
      { agent_config_id: "existing", version: 1, system_prompt: "s" },
    ]);
    const sessions = await client.query<{ agent_config_version: number }>(
      "SELECT agent_config_version FROM sessions WHERE id = 'session'",
    );
    expect(sessions.rows[0]?.agent_config_version).toBe(1);
  });
});
