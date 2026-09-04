// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  E2B_API_KEY: "test-e2b-key",
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
      sandboxTimeoutMs: 30 * 60_000,
      dbPoolMax: 10,
    });
  });

  it("parses the numeric knobs", () => {
    const cfg = loadConfig({
      ...BASE,
      FUNKY_LEASE_MS: "3000",
      FUNKY_IDLE_POLL_MS: "100",
      FUNKY_SANDBOX_TIMEOUT_MS: "300000",
      DB_POOL_MAX: "2",
    });
    expect(cfg.leaseMs).toBe(3_000);
    expect(cfg.idlePollMs).toBe(100);
    expect(cfg.sandboxTimeoutMs).toBe(300_000);
    expect(cfg.dbPoolMax).toBe(2);
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

describe("loadConfig — invalid input", () => {
  it.each(["DATABASE_URL", "E2B_API_KEY"] as const)("exits when %s is missing", (key) => {
    const env: Record<string, string> = { ...BASE };
    delete env[key];
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
