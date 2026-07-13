// apps/worker/src/config.ts
// The only place process.env is read. dotenv is loaded by index.ts (entrypoint), not here.
// Mirrors apps/api/src/config.ts: zod, fail-fast via process.exit(1); never boot half-configured.
import { z } from "zod";

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    FUNKY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(50),
    FUNKY_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
    FUNKY_LLM: z.enum(["fake", "ai-sdk"]).default("fake"),
    FUNKY_SANDBOX: z.enum(["subprocess"]).default("subprocess"),
    // Required ONLY when FUNKY_LLM=ai-sdk (the fake driver makes no network calls).
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  })
  .refine((e) => e.FUNKY_LLM !== "ai-sdk" || e.ANTHROPIC_API_KEY !== undefined, {
    message:
      "ANTHROPIC_API_KEY is required when FUNKY_LLM=ai-sdk. " +
      "Set it, or leave FUNKY_LLM=fake for local development.",
    path: ["ANTHROPIC_API_KEY"],
  });

export type Config = {
  databaseUrl: string;
  concurrency: number;
  healthPort: number;
  llm: "fake" | "ai-sdk";
  sandbox: "subprocess";
  /** null = fake driver; no key needed. */
  anthropicApiKey: string | null;
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
    dbPoolMax: e.DB_POOL_MAX,
  };
}
