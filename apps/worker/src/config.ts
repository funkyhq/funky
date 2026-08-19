// apps/worker/src/config.ts
// The single place env is parsed (main.ts is the only caller): zod,
// fail-fast via process.exit(1) — never boot half-configured. Every
// secret is required: this worker exists to
// run real steps against a real vendor and a real sandbox; a keyless
// variant would claim items it cannot serve.
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  E2B_API_KEY: z.string().min(1, "E2B_API_KEY is required"),
  // Lease duration per claim; each heartbeat extends by the same amount.
  FUNKY_LEASE_MS: z.coerce.number().int().min(100).default(60_000),
  // Delay between empty claim attempts — poll-only until a Notifier port exists.
  FUNKY_IDLE_POLL_MS: z.coerce.number().int().min(10).default(1_000),
  // Idle TTL before a session's sandbox auto-pauses (revived on the next connect).
  FUNKY_SANDBOX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(30 * 60_000),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
});

export type Config = {
  databaseUrl: string;
  anthropicApiKey: string;
  e2bApiKey: string;
  leaseMs: number;
  idlePollMs: number;
  sandboxTimeoutMs: number;
  dbPoolMax: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`)
      .join("\n");
    console.error(`worker: invalid configuration:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    e2bApiKey: e.E2B_API_KEY,
    leaseMs: e.FUNKY_LEASE_MS,
    idlePollMs: e.FUNKY_IDLE_POLL_MS,
    sandboxTimeoutMs: e.FUNKY_SANDBOX_TIMEOUT_MS,
    dbPoolMax: e.DB_POOL_MAX,
  };
}
