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
      sandbox: "docker",
      anthropicApiKey: null,
      e2bApiKey: null,
      e2bSandboxTimeoutMs: 30 * 60_000,
      dockerImage: "funky-sandbox:trixie",
      dbPoolMax: 10,
      harnessCwdRoot: "/tmp/funky-harness-cwd",
      harnessScratchRoot: "/tmp/funky-harness-scratch",
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("defaults the docker driver's image and lets FUNKY_DOCKER_IMAGE override it", () => {
    expect(loadConfig(BASE).dockerImage).toBe("funky-sandbox:trixie");
    expect(loadConfig({ ...BASE, FUNKY_DOCKER_IMAGE: "my-sandbox:latest" })).toMatchObject({
      sandbox: "docker",
      dockerImage: "my-sandbox:latest",
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("treats empty-string secrets as absent (compose `${VAR:-}` sends '' for unset keys)", () => {
    const cfg = loadConfig({ ...BASE, ANTHROPIC_API_KEY: "", E2B_API_KEY: "" });
    expect(cfg.anthropicApiKey).toBeNull();
    expect(cfg.e2bApiKey).toBeNull();
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
      FUNKY_SANDBOX: "e2b",
      E2B_API_KEY: "e2b_secret",
      FUNKY_E2B_SANDBOX_TIMEOUT_MS: "600000",
      FUNKY_HARNESS_CWD_ROOT: "/var/funky/cwd",
      FUNKY_HARNESS_SCRATCH_ROOT: "/dev/shm/funky",
    });
    expect(cfg).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      concurrency: 8,
      healthPort: 9191,
      llm: "ai-sdk",
      sandbox: "e2b",
      anthropicApiKey: "sk-ant-secret",
      e2bApiKey: "e2b_secret",
      e2bSandboxTimeoutMs: 600_000,
      dockerImage: "funky-sandbox:trixie",
      dbPoolMax: 25,
      harnessCwdRoot: "/var/funky/cwd",
      harnessScratchRoot: "/dev/shm/funky",
    });
  });
});

describe("loadConfig — invalid input exits the process", () => {
  it.each([
    ["missing DATABASE_URL", {}],
    ["empty DATABASE_URL", { DATABASE_URL: "" }],
    ["ai-sdk without ANTHROPIC_API_KEY", { ...BASE, FUNKY_LLM: "ai-sdk" }],
    ["e2b without E2B_API_KEY", { ...BASE, FUNKY_SANDBOX: "e2b" }],
    ["e2b with empty E2B_API_KEY", { ...BASE, FUNKY_SANDBOX: "e2b", E2B_API_KEY: "" }],
    [
      "e2b sandbox timeout below 60s",
      { ...BASE, FUNKY_SANDBOX: "e2b", E2B_API_KEY: "e2b_x", FUNKY_E2B_SANDBOX_TIMEOUT_MS: "1000" },
    ],
    ["concurrency below 1", { ...BASE, FUNKY_WORKER_CONCURRENCY: "0" }],
    ["concurrency not a number", { ...BASE, FUNKY_WORKER_CONCURRENCY: "lots" }],
    ["health port out of range", { ...BASE, FUNKY_WORKER_HEALTH_PORT: "70000" }],
    ["unknown FUNKY_LLM", { ...BASE, FUNKY_LLM: "gpt" }],
    ["unknown FUNKY_SANDBOX", { ...BASE, FUNKY_SANDBOX: "podman" }],
    ["subprocess is not a production sandbox option", { ...BASE, FUNKY_SANDBOX: "subprocess" }],
    ["DB_POOL_MAX below 1", { ...BASE, DB_POOL_MAX: "0" }],
  ])("exits on %s", (_label, env) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });
});
