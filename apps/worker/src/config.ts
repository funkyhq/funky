// apps/worker/src/config.ts
// The single place env is parsed (main.ts is the only caller): zod,
// fail-fast via process.exit(1) — never boot half-configured. Every
// secret is required, with one shape of choice: this worker exists to
// run real steps against a real vendor and a real sandbox, and which
// vendors is the deployment's call — any of the table in providers.ts,
// at least one. A keyless variant would claim items it cannot serve.
import { z } from "zod";
import { VENDORS } from "./providers";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
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
  /** Model-provider keys by vendor id (providers.ts), the set ones only;
   *  never empty. main.ts wires one inference adapter per entry. */
  providerKeys: ReadonlyMap<string, string>;
  e2bApiKey: string;
  leaseMs: number;
  idlePollMs: number;
  sandboxTimeoutMs: number;
  dbPoolMax: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  const providerKeys = readProviderKeys(env);

  // Report everything wrong at once, so one restart fixes it all.
  const issues: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "env"}: ${issue.message}`);
    }
  }
  if (providerKeys.size === 0) {
    const accepted = VENDORS.map((vendor) => vendor.envKey).join(", ");
    issues.push(`env: set a key for at least one model provider (${accepted})`);
  }
  // A non-empty list already implies `!parsed.success` when the schema
  // failed; the check is repeated so `parsed` narrows to its data below.
  if (!parsed.success || issues.length > 0) {
    const listed = issues.map((issue) => `  - ${issue}`).join("\n");
    console.error(`worker: invalid configuration:\n${listed}`);
    process.exit(1);
  }

  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    providerKeys,
    e2bApiKey: e.E2B_API_KEY,
    leaseMs: e.FUNKY_LEASE_MS,
    idlePollMs: e.FUNKY_IDLE_POLL_MS,
    sandboxTimeoutMs: e.FUNKY_SANDBOX_TIMEOUT_MS,
    dbPoolMax: e.DB_POOL_MAX,
  };
}

/** The vendor keys that are set, by vendor id. Empty or blank reads as
 *  unset: .env.example ships the vars empty, and compose forwards an
 *  unset one as "". */
function readProviderKeys(env: NodeJS.ProcessEnv): Map<string, string> {
  const keys = new Map<string, string>();
  for (const vendor of VENDORS) {
    const value = env[vendor.envKey]?.trim();
    if (value) keys.set(vendor.id, value);
  }
  return keys;
}
