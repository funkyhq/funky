// Schema-shape regression tests: assert the Drizzle table definitions in
// schema/configs.ts still match the physical shape the migrations created.
// These run without a database — getTableConfig() reflects the in-memory model,
// so a rename, a dropped NOT NULL, a changed default, or a broken PK/FK/index
// fails here loudly instead of silently drifting from migrations/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { agentConfigs, agentConfigVersions, type ModelConfig } from "./schema";

type ColSpec = {
  type: string; // getSQLType() output, e.g. "uuid", "timestamp with time zone"
  notNull: boolean;
  hasDefault?: boolean;
  default?: unknown; // deep-equal check; omit for SQL defaults like now()
  primary?: boolean; // inline single-column primary key
};

function columnsByName(table: PgTable) {
  return new Map(getTableConfig(table).columns.map((c) => [c.name, c]));
}

/** Assert the table has exactly `expected`'s columns, each with the given shape. */
function assertColumns(table: PgTable, expected: Record<string, ColSpec>) {
  const cols = columnsByName(table);
  assert.deepEqual(
    [...cols.keys()].sort(),
    Object.keys(expected).sort(),
    "column set drifted (added/removed column)",
  );
  for (const [name, spec] of Object.entries(expected)) {
    const col = cols.get(name);
    assert.ok(col, `missing column ${name}`);
    assert.equal(col.getSQLType(), spec.type, `${name}.type`);
    assert.equal(col.notNull, spec.notNull, `${name}.notNull`);
    if (spec.hasDefault !== undefined) {
      assert.equal(col.hasDefault, spec.hasDefault, `${name}.hasDefault`);
    }
    if (spec.default !== undefined) {
      assert.deepEqual(col.default, spec.default, `${name}.default`);
    }
    if (spec.primary !== undefined) {
      assert.equal(col.primary, spec.primary, `${name}.primary`);
    }
  }
}

function indexSummaries(table: PgTable) {
  return getTableConfig(table)
    .indexes.map((i) => ({
      name: i.config.name ?? "", // named indexes only here; guard the type anyway
      columns: i.config.columns.map((c) => (c as { name?: string }).name),
      unique: i.config.unique,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- agent_configs

test("agent_configs: table name", () => {
  assert.equal(getTableConfig(agentConfigs).name, "agent_configs");
});

test("agent_configs: columns match the migration", () => {
  assertColumns(agentConfigs, {
    id: { type: "uuid", notNull: true, primary: true },
    namespace: { type: "text", notNull: true },
    name: { type: "text", notNull: true },
    description: { type: "text", notNull: false },
    metadata: { type: "jsonb", notNull: true, hasDefault: true, default: {} },
    latest_version: { type: "integer", notNull: true, hasDefault: true, default: 1 },
    created_at: { type: "timestamp with time zone", notNull: true, hasDefault: true },
    updated_at: { type: "timestamp with time zone", notNull: true, hasDefault: true },
    archived_at: { type: "timestamp with time zone", notNull: false },
  });
});

test("agent_configs: id is an inline primary key (no composite PK, no FKs)", () => {
  const cfg = getTableConfig(agentConfigs);
  assert.equal(cfg.primaryKeys.length, 0, "identity uses an inline PK, not a composite one");
  assert.equal(cfg.foreignKeys.length, 0, "identity table references nothing");
});

test("agent_configs: has the two namespace lookup indexes, both non-unique", () => {
  // name is a display label, not a reference — the (namespace, name) index must
  // stay non-unique so duplicate names within a namespace are allowed.
  assert.deepEqual(indexSummaries(agentConfigs), [
    { name: "agent_configs_ns", columns: ["namespace"], unique: false },
    { name: "agent_configs_ns_name", columns: ["namespace", "name"], unique: false },
  ]);
});

// -------------------------------------------------------- agent_config_versions

test("agent_config_versions: table name", () => {
  assert.equal(getTableConfig(agentConfigVersions).name, "agent_config_versions");
});

test("agent_config_versions: columns match the migration", () => {
  assertColumns(agentConfigVersions, {
    agent_config_id: { type: "uuid", notNull: true },
    version: { type: "integer", notNull: true },
    namespace: { type: "text", notNull: true },
    system_prompt: { type: "text", notNull: true },
    model: { type: "jsonb", notNull: true },
    tool_policy: { type: "jsonb", notNull: true, hasDefault: true, default: {} },
    created_at: { type: "timestamp with time zone", notNull: true, hasDefault: true },
    created_by: { type: "text", notNull: false },
  });
});

test("agent_config_versions: composite primary key is (agent_config_id, version)", () => {
  const pks = getTableConfig(agentConfigVersions).primaryKeys;
  assert.equal(pks.length, 1);
  assert.deepEqual(
    pks[0]?.columns.map((c) => c.name),
    ["agent_config_id", "version"],
  );
});

test("agent_config_versions: agent_config_id references agent_configs.id", () => {
  const fks = getTableConfig(agentConfigVersions).foreignKeys;
  assert.equal(fks.length, 1, "exactly one foreign key");
  const ref = fks[0]!.reference();
  assert.deepEqual(ref.columns.map((c) => c.name), ["agent_config_id"]);
  assert.deepEqual(ref.foreignColumns.map((c) => c.name), ["id"]);
  assert.equal(getTableConfig(ref.foreignTable).name, "agent_configs");
});

// ------------------------------------------------------------------ ModelConfig

test("ModelConfig: provider is constrained to the supported union", () => {
  const model: ModelConfig = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    maxTokens: 1024,
    temperature: 0.7,
  };
  assert.equal(model.provider, "anthropic");

  // Compile-time guard: an unsupported provider must not type-check. tsx strips
  // types at runtime, so this line is inert then; `tsc --noEmit` enforces it.
  // @ts-expect-error "cohere" is not a member of the provider union
  const unsupported: ModelConfig = { provider: "cohere", model: "x" };
  void unsupported;
});
