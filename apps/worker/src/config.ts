// apps/worker/src/config.ts
// The only place process.env is read. dotenv is loaded by index.ts (entrypoint), not here.
// Mirrors apps/api/src/config.ts: zod, fail-fast via process.exit(1); never boot half-configured.
import { z } from "zod";

// Compose interpolation (`${VAR:-}`) delivers an UNSET optional secret as an EMPTY
// STRING, not as a missing variable — treat "" as absent so the zero-key path boots.
const optionalSecret = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().min(1).optional(),
);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    FUNKY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(50),
    FUNKY_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
    FUNKY_LLM: z.enum(["fake", "ai-sdk"]).default("fake"),
    // docker (default): an isolated container per session on the local daemon — no account.
    // e2b: an isolated remote sandbox per session. (The in-process subprocess driver still
    // exists for the offline test suites, but is not a production sandbox option.)
    FUNKY_SANDBOX: z.enum(["docker", "e2b"]).default("docker"),
    // Required when FUNKY_LLM=ai-sdk, and for agents with runtime=claude-code (the
    // harness driver is only constructed when this key is present).
    ANTHROPIC_API_KEY: optionalSecret,
    // Harness (claude-code) knobs. CWD_ROOT must be identical across the worker
    // fleet — the harness derives the transcript store's projectKey from it.
    // SCRATCH_ROOT holds the disposable per-attempt local session copy; point it at
    // RAM-backed storage (tmpfs) in production.
    FUNKY_HARNESS_CWD_ROOT: z.string().min(1).default("/tmp/funky-harness-cwd"),
    FUNKY_HARNESS_SCRATCH_ROOT: z.string().min(1).default("/tmp/funky-harness-scratch"),
    // Required ONLY when FUNKY_SANDBOX=e2b (docker needs no account).
    E2B_API_KEY: optionalSecret,
    // Base image for the docker driver (built from docker/sandbox.Dockerfile).
    FUNKY_DOCKER_IMAGE: z.string().min(1).default("funky-sandbox:trixie"),
    // Idle lifetime before an e2b sandbox auto-pauses (resumed on the next command).
    FUNKY_E2B_SANDBOX_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(30 * 60_000),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  })
  .refine((e) => e.FUNKY_LLM !== "ai-sdk" || e.ANTHROPIC_API_KEY !== undefined, {
    message:
      "ANTHROPIC_API_KEY is required when FUNKY_LLM=ai-sdk. " +
      "Set it, or leave FUNKY_LLM=fake for local development.",
    path: ["ANTHROPIC_API_KEY"],
  })
  .refine((e) => e.FUNKY_SANDBOX !== "e2b" || e.E2B_API_KEY !== undefined, {
    message:
      "E2B_API_KEY is required when FUNKY_SANDBOX=e2b. " +
      "Set it, or leave FUNKY_SANDBOX=docker for local development.",
    path: ["E2B_API_KEY"],
  });

export type Config = {
  databaseUrl: string;
  concurrency: number;
  healthPort: number;
  llm: "fake" | "ai-sdk";
  sandbox: "docker" | "e2b";
  /** null = fake driver; no key needed. */
  anthropicApiKey: string | null;
  harnessCwdRoot: string;
  harnessScratchRoot: string;
  /** null = docker driver; no key needed. */
  e2bApiKey: string | null;
  e2bSandboxTimeoutMs: number;
  /** Base image for the docker driver. */
  dockerImage: string;
  dbPoolMax: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Fail fast with a readable message; never boot half-configured.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`)
      .join("\n");
    console.error(`funky-worker: invalid configuration:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    concurrency: e.FUNKY_WORKER_CONCURRENCY,
    healthPort: e.FUNKY_WORKER_HEALTH_PORT,
    llm: e.FUNKY_LLM,
    sandbox: e.FUNKY_SANDBOX,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    harnessCwdRoot: e.FUNKY_HARNESS_CWD_ROOT,
    harnessScratchRoot: e.FUNKY_HARNESS_SCRATCH_ROOT,
    e2bApiKey: e.E2B_API_KEY ?? null,
    e2bSandboxTimeoutMs: e.FUNKY_E2B_SANDBOX_TIMEOUT_MS,
    dockerImage: e.FUNKY_DOCKER_IMAGE,
    dbPoolMax: e.DB_POOL_MAX,
  };
}
