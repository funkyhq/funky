// packages/db/schema/configs.ts
// Agent config = identity + immutable versions (two tables).
// Sessions pin (agent_config_id, version) at creation; versions are never UPDATEd —
// "editing" an agent = INSERT next version + bump latest_version, in one transaction.
//
// Identity vs version split rule: fields that change agent BEHAVIOR (system_prompt,
// model, tool_policy) live on versions; labels (name, description, metadata)
// live on identity and mutate freely without a version bump.
//
// Deliberately absent for v1 (worker doesn't support them yet — add when it does):
// skills[], mcp_servers, tools[] beyond tool_policy. When skills land, they go on
// the versions table (behavior) as jsonb refs into the skills registry. Env configs
// live in envs.ts (single table + archive, NOT versioned — sessions snapshot
// resolved_env at provision).

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Mirrors what the AI SDK needs to construct a model. Validated with zod at the API edge. */
/** How the agent's turns execute. null/omitted = "native": Funky's own loop
 *  (reducer + LLM port). "claude-code" = the Claude Code harness drives the turn
 *  (packages/ports/harness). Behavior, so it lives on VERSIONS and is pinned per
 *  session — a session's runtime never changes mid-life. */
export type RuntimeConfig = { type: "native" } | { type: "claude-code" };

export type ModelConfig = {
  provider:
    | "anthropic"
    | "openai"
    | "google"
    | "xai"
    | "openrouter"
    | "togetherai"
    | "fireworks"
    | "baseten";
  model: string; // e.g. "claude-sonnet-5"
  maxTokens?: number;
  temperature?: number;
};

// ---------------------------------------------------------------------------
// Identity: mutable pointer (name, latest_version), soft-deletable
// ---------------------------------------------------------------------------
export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").primaryKey(), // client-supplied → idempotent PUT /agents/:id
    // Sessions reference agents by ID (+ optional version), matching the Managed
    // Agents API. `name` is therefore a display label — NOT unique, NOT a reference.
    namespace: text("namespace").notNull(), // opaque partition key ("default" in OSS)
    name: text("name").notNull(), // 1-256 chars, free-form; validated at API edge
    description: text("description"), // identity-level metadata: mutable WITHOUT a version bump
    metadata: jsonb("metadata")
      .$type<Record<string, string>>()
      .notNull()
      .default({}), // user labels; enforce ≤16 pairs at the API edge
    latestVersion: integer("latest_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Archive, not delete (matches Managed Agents: agents have no DELETE endpoint).
    // Archived = permanent read-only: existing sessions continue, new sessions
    // cannot reference it, no unarchive. Enforced in the service layer.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // non-unique: supports list/search by name; duplicates are allowed
    index("agent_configs_ns_name").on(t.namespace, t.name),
    index("agent_configs_ns").on(t.namespace),
  ],
);

// ---------------------------------------------------------------------------
// Versions: append-only, immutable. No UPDATE on this table, ever.
// ---------------------------------------------------------------------------
export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id),
    version: integer("version").notNull(), // 1, 2, 3… per agent
    namespace: text("namespace").notNull(), // denormalized for tenancy scoping/RLS

    // ---- the actual config (name/model/system prompt requirement lives here) ----
    systemPrompt: text("system_prompt").notNull(),
    model: jsonb("model").$type<ModelConfig>().notNull(),
    toolPolicy: jsonb("tool_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}), // allowed tools, max turns/iterations, budgets
    // null = native loop (backwards compatible). Validated with zod at the API edge.
    runtime: jsonb("runtime").$type<RuntimeConfig>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"), // opaque principal: "user:123" | "key:fk_live_a1b2"
  },
  (t) => [primaryKey({ columns: [t.agentConfigId, t.version] })],
);
