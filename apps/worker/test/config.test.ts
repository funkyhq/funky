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

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig — valid input", () => {
  it("applies defaults for a minimal environment", () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      anthropicApiKey: BASE.ANTHROPIC_API_KEY,
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

describe("loadConfig — invalid input", () => {
  it.each(["DATABASE_URL", "ANTHROPIC_API_KEY", "E2B_API_KEY"] as const)(
    "exits when %s is missing",
    (key) => {
      const env: Record<string, string> = { ...BASE };
      delete env[key];
      expect(() => loadConfig(env)).toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );
});
