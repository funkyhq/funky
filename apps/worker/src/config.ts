// apps/worker/src/config.ts
// The single place env is parsed (main.ts is the only caller): zod,
// fail-fast via process.exit(1) — never boot half-configured. Every
// secret is required, with one shape of choice: this worker exists to
// run real steps against a real vendor and a real sandbox, and which
// vendors is the deployment's call — any of the table in providers.ts,
// at least one. A keyless variant would claim items it cannot serve.
import { z } from "zod";
import { VENDORS } from "./providers";

/** An integer knob with a floor and a default. Blank reads as unset —
 *  the rule the provider keys already follow, since compose forwards an
 *  unset variable as "" — where coercion alone would read it as 0: a
 *  boot failure under a floor of 1, a silent zero budget under a floor
 *  of 0. */
const intKnob = (min: number, fallback: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(min).default(fallback),
  );

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  E2B_API_KEY: z.string().min(1, "E2B_API_KEY is required"),
  // Lease duration per claim; each heartbeat extends by the same amount.
  FUNKY_LEASE_MS: intKnob(100, 60_000),
  // Delay between empty claim attempts — poll-only until a Notifier port exists.
  FUNKY_IDLE_POLL_MS: intKnob(10, 1_000),
  // Drain budget: how long a held step may keep running after SIGTERM
  // before it is aborted and its lease released. Cloud Run (and compose)
  // send SIGKILL 10s after SIGTERM; the default leaves 3s for the
  // release's round trip and the exit.
  FUNKY_DRAIN_MS: intKnob(0, 7_000),
  // Idle TTL before a session's sandbox auto-pauses (revived on the next connect).
  FUNKY_SANDBOX_TIMEOUT_MS: intKnob(10_000, 30 * 60_000),
  // Drivers this worker hosts — claim loops run side by side in one
  // process over one pool and one drain, so the steps it runs at once;
  // `--scale worker=N` multiplies it. A step is a stream in flight (a
  // model, a sandbox), not CPU, so tens fit a small container; what they
  // share and queue on is the pool below, and each polls when idle.
  FUNKY_CONCURRENCY: intKnob(1, 1),
  DB_POOL_MAX: intKnob(1, 10),
});

export type Config = {
  databaseUrl: string;
  /** Model-provider keys by vendor id (providers.ts), the set ones only;
   *  never empty. main.ts wires one inference adapter per entry. */
  providerKeys: ReadonlyMap<string, string>;
  e2bApiKey: string;
  leaseMs: number;
  idlePollMs: number;
  drainMs: number;
  sandboxTimeoutMs: number;
  /** Drivers main.ts hosts, each one claim loop. At least 1. */
  concurrency: number;
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
    drainMs: e.FUNKY_DRAIN_MS,
    sandboxTimeoutMs: e.FUNKY_SANDBOX_TIMEOUT_MS,
    concurrency: e.FUNKY_CONCURRENCY,
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
