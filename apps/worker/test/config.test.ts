// loadConfig(env) is the single place env is parsed. It fails fast via process.exit(1);
// tests stub exit so the failure path is observable. Mirrors apps/api/test/config.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = { DATABASE_URL: "postgres://funky:funky@localhost:5432/funky" };

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
    const cfg = loadConfig(BASE);
    expect(cfg).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      concurrency: 50,
      healthPort: 9090,
      llm: "fake",
      sandbox: "subprocess",
      anthropicApiKey: null,
      dbPoolMax: 10,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("parses a fully-specified environment", () => {
    const cfg = loadConfig({
      ...BASE,
      FUNKY_WORKER_CONCURRENCY: "8",
      FUNKY_WORKER_HEALTH_PORT: "9191",
      DB_POOL_MAX: "25",
      FUNKY_LLM: "ai-sdk",
      ANTHROPIC_API_KEY: "sk-ant-secret",
    });
    expect(cfg).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      concurrency: 8,
      healthPort: 9191,
      llm: "ai-sdk",
      sandbox: "subprocess",
      anthropicApiKey: "sk-ant-secret",
      dbPoolMax: 25,
    });
  });
});

describe("loadConfig — invalid input exits the process", () => {
  it.each([
    ["missing DATABASE_URL", {}],
    ["empty DATABASE_URL", { DATABASE_URL: "" }],
    ["ai-sdk without ANTHROPIC_API_KEY", { ...BASE, FUNKY_LLM: "ai-sdk" }],
    ["concurrency below 1", { ...BASE, FUNKY_WORKER_CONCURRENCY: "0" }],
    ["concurrency not a number", { ...BASE, FUNKY_WORKER_CONCURRENCY: "lots" }],
    ["health port out of range", { ...BASE, FUNKY_WORKER_HEALTH_PORT: "70000" }],
    ["unknown FUNKY_LLM", { ...BASE, FUNKY_LLM: "gpt" }],
    ["unknown FUNKY_SANDBOX", { ...BASE, FUNKY_SANDBOX: "docker" }],
    ["DB_POOL_MAX below 1", { ...BASE, DB_POOL_MAX: "0" }],
  ])("exits on %s", (_label, env) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });
});
