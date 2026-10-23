// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  E2B_API_KEY: "test-e2b-key",
};

const INFISICAL = {
  INFISICAL_CLIENT_ID: "5c4f1d3e-0000-4000-8000-000000000001",
  INFISICAL_CLIENT_SECRET: "fake-client-secret",
  INFISICAL_PROJECT_ID: "5c4f1d3e-0000-4000-8000-000000000002",
  INFISICAL_ENVIRONMENT: "dev",
};

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig — valid input", () => {
  it("applies defaults for a minimal environment", () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      providerKeys: new Map([["anthropic", BASE.ANTHROPIC_API_KEY]]),
      e2bApiKey: BASE.E2B_API_KEY,
      leaseMs: 60_000,
      idlePollMs: 1_000,
      drainMs: 7_000,
      bindTimeoutMs: 10 * 60_000,
      sandboxTimeoutMs: 30 * 60_000,
      concurrency: 1,
      dbPoolMax: 10,
      infisical: null,
    });
  });

  it("parses the numeric knobs", () => {
    const cfg = loadConfig({
      ...BASE,
      FUNKY_LEASE_MS: "3000",
      FUNKY_IDLE_POLL_MS: "100",
      FUNKY_DRAIN_MS: "500",
      FUNKY_BIND_TIMEOUT_MS: "120000",
      FUNKY_SANDBOX_TIMEOUT_MS: "300000",
      FUNKY_CONCURRENCY: "4",
      DB_POOL_MAX: "2",
    });
    expect(cfg.leaseMs).toBe(3_000);
    expect(cfg.idlePollMs).toBe(100);
    expect(cfg.drainMs).toBe(500);
    expect(cfg.bindTimeoutMs).toBe(120_000);
    expect(cfg.sandboxTimeoutMs).toBe(300_000);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.dbPoolMax).toBe(2);
  });

  it("reads a blank numeric knob as unset — compose forwards an unset one as empty", () => {
    // Coercion alone would read "" as 0: a boot failure for a knob whose
    // floor is 1, and a silent zero budget for the drain, whose floor is 0.
    const cfg = loadConfig({ ...BASE, FUNKY_CONCURRENCY: "", FUNKY_DRAIN_MS: "  " });
    expect(cfg.concurrency).toBe(1);
    expect(cfg.drainMs).toBe(7_000);
  });
});

describe("loadConfig — model provider keys", () => {
  it("reads every vendor key that is set, by vendor id", () => {
    const cfg = loadConfig({
      ...BASE,
      OPENAI_API_KEY: "test-openai-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "test-google-key",
      TOGETHER_API_KEY: "test-together-key",
      XAI_API_KEY: "test-xai-key",
    });
    expect(cfg.providerKeys).toEqual(
      new Map([
        ["anthropic", BASE.ANTHROPIC_API_KEY],
        ["openai", "test-openai-key"],
        ["google", "test-google-key"],
        ["togetherai", "test-together-key"],
        ["xai", "test-xai-key"],
      ]),
    );
  });

  it("boots on any one vendor — Anthropic is not special", () => {
    const env: Record<string, string> = {
      ...BASE,
      GOOGLE_GENERATIVE_AI_API_KEY: "test-google-key",
    };
    delete env["ANTHROPIC_API_KEY"];
    expect(loadConfig(env).providerKeys).toEqual(new Map([["google", "test-google-key"]]));
  });

  it("reads an empty or blank key as unset — .env.example ships them empty", () => {
    const cfg = loadConfig({ ...BASE, OPENAI_API_KEY: "", TOGETHER_API_KEY: "  " });
    expect(cfg.providerKeys).toEqual(new Map([["anthropic", BASE.ANTHROPIC_API_KEY]]));
  });

  it("exits with no vendor key set, naming every one it would take", () => {
    expect(() => loadConfig({ ...BASE, ANTHROPIC_API_KEY: "" })).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, TOGETHER_API_KEY, XAI_API_KEY",
      ),
    );
  });
});

describe("loadConfig — secret store", () => {
  it("reads an Infisical identity as the store credentials' keys come from", () => {
    expect(loadConfig({ ...BASE, ...INFISICAL }).infisical).toEqual({
      clientId: INFISICAL.INFISICAL_CLIENT_ID,
      clientSecret: INFISICAL.INFISICAL_CLIENT_SECRET,
      projectId: INFISICAL.INFISICAL_PROJECT_ID,
      environment: INFISICAL.INFISICAL_ENVIRONMENT,
    });
  });

  it("reads blank Infisical variables as unset, the way compose forwards unset ones", () => {
    const blank = Object.fromEntries(Object.keys(INFISICAL).map((key) => [key, " "]));
    expect(loadConfig({ ...BASE, ...blank }).infisical).toBeNull();
  });

  it("exits on part of an identity, naming each missing variable with the other issues", () => {
    const { INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET } = INFISICAL;
    const env: Record<string, string> = {
      ...BASE,
      INFISICAL_CLIENT_ID,
      INFISICAL_CLIENT_SECRET,
      INFISICAL_ENVIRONMENT: "",
    };
    delete env["DATABASE_URL"];
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    const printed = vi.mocked(console.error).mock.calls.flat().join("\n");
    // One report, so one restart fixes it all.
    expect(printed).toContain("DATABASE_URL");
    expect(printed).toContain(
      "INFISICAL_PROJECT_ID: required with the rest of the Infisical identity",
    );
    expect(printed).toContain(
      "INFISICAL_ENVIRONMENT: required with the rest of the Infisical identity",
    );
    expect(printed).not.toContain("INFISICAL_CLIENT_ID:");
    expect(printed).not.toContain(INFISICAL_CLIENT_SECRET);
  });
});

describe("loadConfig — invalid input", () => {
  it.each(["DATABASE_URL", "E2B_API_KEY"] as const)("exits when %s is missing", (key) => {
    const env: Record<string, string> = { ...BASE };
    delete env[key];
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(["0", "-1", "1.5", "two"])("exits on a concurrency of %s", (value) => {
    expect(() => loadConfig({ ...BASE, FUNKY_CONCURRENCY: value })).toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FUNKY_CONCURRENCY"));
  });
});
