// packages/db/schema/envs.ts
// Environment config = the reusable, template-like recipe for a session's sandbox
// (egress policy). One environment fans out to many sessions; each session provisions
// its OWN isolated sandbox (filesystem is per-session, never shared). Single table +
// archive, NOT versioned: the config is consumed once at sandbox provision, so updates
// only affect future sessions. When sessions land they snapshot resolved_env at
// provision; see configs.ts.
//
// Deliberately NOT here: base_image and persistent_fs. Neither is honored by any driver
// (E2B has no create-time image/disk-size param — both are template-build-time concerns;
// subprocess runs in the worker container). The runtime image is the backend's concern;
// per-session durable storage, if ever needed, belongs on the session as a volume
// resource, not as a knob on the template.

import {
  index, jsonb, pgTable, text, timestamp, uuid,
} from "drizzle-orm/pg-core";

export type EgressPolicy = { allow: string[] }; // domain allowlist; [] = deny all egress

export const envConfigs = pgTable(
  "env_configs",
  {
    id: uuid("id").primaryKey(),              // client-supplied → idempotent create
    namespace: text("namespace").notNull(),
    name: text("name").notNull(),             // display label, non-unique
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),

    // ---- the recipe ----
    egress: jsonb("egress").$type<EgressPolicy>().notNull().default({ allow: [] }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("env_configs_ns_name").on(t.namespace, t.name),
    index("env_configs_ns").on(t.namespace),
  ],
);
