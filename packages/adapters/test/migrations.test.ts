// Shipped migrations are append-only. The migrator records each migration
// by its folder name and never reads a recorded one again, so an edit to a
// shipped file reaches no existing database: `migrate` reports the schema
// current, and the new code then fails against the old schema. Databases
// exist that were created from these files, so a schema change is a new
// migration beside them (migrations/README.md).
//
// Each migration is pinned here by the SHA-256 of its SQL — the hash the
// migrator itself records in __drizzle_migrations — in the PR that adds it;
// from then on it is frozen.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "./migrate-store";

const SHIPPED: Record<string, string> = {
  "20260820000000_init": "74a514e227d93b2ce90ca1e1792176aa7e330fd0381c1775c159ddf08b385c63",
  "20261026180444_add_agent_config_setup_commands":
    "7f315fbe305d053e1f37c3086918fac4ca8f31b707f4e781b415e00109739f3b",
};

const hashes = new Map(migrations.map((m) => [m.name, m.hash]));

describe("shipped migrations", () => {
  it.each(Object.entries(SHIPPED))("%s is unchanged", (name, pinned) => {
    expect(hashes.has(name), `${name} was removed or renamed`).toBe(true);
    expect(
      hashes.get(name),
      `${name} changed after it shipped: revert it, and make the change a new migration (migrations/README.md)`,
    ).toBe(pinned);
  });

  it("pins every migration, each named for the order it applies in", () => {
    for (const { name, hash } of migrations) {
      expect(name, "a migration folder is <yyyyMMddHHmmss>_<snake_case_name>").toMatch(
        /^\d{14}_[a-z0-9_]+$/,
      );
      expect(
        SHIPPED[name],
        `${name} is not pinned: add "${name}": "${hash}" to the end of SHIPPED`,
      ).toBeDefined();
    }
    // SHIPPED is in shipping order — the order deployed databases applied them in.
    expect(
      migrations.map((m) => m.name),
      "a new migration must sort after every shipped one: rename it for the current UTC time",
    ).toEqual(Object.keys(SHIPPED));
  });
});

describe("20261026180444_add_agent_config_setup_commands", () => {
  // One database for both tests, booted once: PGlite takes seconds to
  // start on a CI runner. It is at the init, holding one agent config
  // version saved then, when the migration runs.
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    const at = (name: string) => migrations.find((m) => m.name === name)!;
    for (const chunk of at("20260820000000_init").sql) await db.exec(chunk);
    await db.exec(`
      INSERT INTO agent_configs VALUES ('default', 'a1', 1, now(), NULL);
      INSERT INTO agent_config_versions
        (namespace, agent_config_id, version, inference, system_prompt, network, packages, credentials, updated_at)
        VALUES ('default', 'a1', 1, '{}', 's', '{}', '{}', '[]', now());
    `);
    for (const chunk of at("20261026180444_add_agent_config_setup_commands").sql) {
      await db.exec(chunk);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("gives versions saved before it no setup commands", async () => {
    const { rows } = await db.query("SELECT setup_commands FROM agent_config_versions");
    expect(rows).toEqual([{ setup_commands: [] }]);
  });

  it("leaves no default behind: a write without setup commands is refused", async () => {
    await expect(
      db.exec(`
        INSERT INTO agent_config_versions
          (namespace, agent_config_id, version, inference, system_prompt, network, packages, credentials, updated_at)
          VALUES ('default', 'a1', 2, '{}', 's', '{}', '{}', '[]', now());
      `),
    ).rejects.toThrow(/setup_commands/);
  });
});
