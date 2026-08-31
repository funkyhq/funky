// apps/api/src/config.ts
// The single place env is parsed (main.ts is the only caller): zod,
// fail-fast via process.exit(1) — never boot half-configured. Auth is
// required by default; disabling it is an explicit, loudly-warned dev
// override, never an omission.
import { z } from "zod";

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    FUNKY_AUTH: z.enum(["enabled", "disabled"]).default("enabled"),
    FUNKY_AUTH_TOKEN: z.string().min(16, "FUNKY_AUTH_TOKEN must be ≥16 chars").optional(),
    /** SSE tail pacing: how often /stream re-polls the entries cursor,
     *  and how long a quiet stream goes before a keep-alive comment. */
    FUNKY_STREAM_POLL_MS: z.coerce.number().int().min(1).default(1000),
    FUNKY_STREAM_HEARTBEAT_MS: z.coerce.number().int().min(1).default(15_000),
  })
  .refine((e) => e.FUNKY_AUTH === "disabled" || e.FUNKY_AUTH_TOKEN !== undefined, {
    message:
      "FUNKY_AUTH_TOKEN is required. Set it in the environment, " +
      "or set FUNKY_AUTH=disabled for local development (NOT for anything reachable).",
  })
  // The stream loop checks the heartbeat once per poll, so a poll slower
  // than the heartbeat would silently stretch the keepalive past its
  // schedule. Refuse the combination rather than complicate the loop.
  .refine((e) => e.FUNKY_STREAM_POLL_MS <= e.FUNKY_STREAM_HEARTBEAT_MS, {
    path: ["FUNKY_STREAM_POLL_MS"],
    message: "FUNKY_STREAM_POLL_MS must not exceed FUNKY_STREAM_HEARTBEAT_MS",
  });

export type Config = {
  databaseUrl: string;
  port: number;
  dbPoolMax: number;
  /** null = auth explicitly disabled (dev only) */
  authToken: string | null;
  streamPollMs: number;
  streamHeartbeatMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`)
      .join("\n");
    console.error(`api: invalid configuration:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;
  if (e.FUNKY_AUTH === "disabled") {
    console.warn("⚠️  FUNKY_AUTH=disabled — the API accepts unauthenticated requests. Dev only.");
  }
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    dbPoolMax: e.DB_POOL_MAX,
    authToken: e.FUNKY_AUTH === "disabled" ? null : e.FUNKY_AUTH_TOKEN!,
    streamPollMs: e.FUNKY_STREAM_POLL_MS,
    streamHeartbeatMs: e.FUNKY_STREAM_HEARTBEAT_MS,
  };
}
