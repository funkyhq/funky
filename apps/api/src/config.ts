// apps/api/src/config.ts
// The only place process.env is read. dotenv is loaded by index.ts (entrypoint), not here.
import { z } from "zod";

export type NamespaceSource = "static" | "header";

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    FUNKY_AUTH: z.enum(["enabled", "disabled"]).default("enabled"),
    FUNKY_AUTH_TOKEN: z.string().min(16, "FUNKY_AUTH_TOKEN must be ≥16 chars").optional(),
    FUNKY_NAMESPACE_SOURCE: z.enum(["static", "header"]).default("static"),
  })
  .refine((e) => e.FUNKY_AUTH === "disabled" || e.FUNKY_AUTH_TOKEN !== undefined, {
    message:
      "FUNKY_AUTH_TOKEN is required. Set it in the environment, " +
      "or set FUNKY_AUTH=disabled for local development (NOT for anything reachable).",
  })
  .refine(
    (e) => e.FUNKY_AUTH !== "disabled" || e.FUNKY_NAMESPACE_SOURCE !== "header",
    {
      path: ["FUNKY_NAMESPACE_SOURCE"],
      message: "FUNKY_NAMESPACE_SOURCE=header requires FUNKY_AUTH=enabled",
    },
  );

export type Config = {
  databaseUrl: string;
  port: number;
  dbPoolMax: number;
  /** null = auth explicitly disabled (dev only) */
  authToken: string | null;
  namespaceSource: NamespaceSource;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Fail fast with a readable message; never boot half-configured.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`)
      .join("\n");
    console.error(`funky-api: invalid configuration:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;
  if (e.FUNKY_AUTH === "disabled") {
    console.warn(
      "⚠️  FUNKY_AUTH=disabled — the API accepts unauthenticated requests. Dev only.",
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    dbPoolMax: e.DB_POOL_MAX,
    authToken: e.FUNKY_AUTH === "disabled" ? null : e.FUNKY_AUTH_TOKEN!,
    namespaceSource: e.FUNKY_NAMESPACE_SOURCE,
  };
}
