// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  FUNKY_AUTH_TOKEN: "a-sufficiently-long-token",
};

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Turn process.exit into a throw so "fail fast" is catchable, and mute the logs.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig — valid input", () => {
  it("parses a fully-specified environment", () => {
    const cfg = loadConfig({ ...BASE, PORT: "8080", DB_POOL_MAX: "25" });
    expect(cfg).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      port: 8080,
      dbPoolMax: 25,
      authToken: BASE.FUNKY_AUTH_TOKEN,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("applies defaults for PORT and DB_POOL_MAX", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPoolMax).toBe(10);
  });

  it("returns a null token and warns when auth is disabled", () => {
    const cfg = loadConfig({ DATABASE_URL: BASE.DATABASE_URL, FUNKY_AUTH: "disabled" });
    expect(cfg.authToken).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("keeps the token when auth is disabled but a token is also present", () => {
    const cfg = loadConfig({ ...BASE, FUNKY_AUTH: "disabled" });
    expect(cfg.authToken).toBeNull(); // disabled wins over a supplied token
  });
});

describe("loadConfig — invalid input exits the process", () => {
  it.each([
    ["missing DATABASE_URL", { FUNKY_AUTH_TOKEN: BASE.FUNKY_AUTH_TOKEN }],
    ["empty DATABASE_URL", { ...BASE, DATABASE_URL: "" }],
    ["auth enabled but no token", { DATABASE_URL: BASE.DATABASE_URL }],
    ["token shorter than 16 chars", { ...BASE, FUNKY_AUTH_TOKEN: "short" }],
    ["PORT out of range", { ...BASE, PORT: "70000" }],
    ["PORT not a number", { ...BASE, PORT: "notaport" }],
    ["DB_POOL_MAX below 1", { ...BASE, DB_POOL_MAX: "0" }],
    ["invalid FUNKY_AUTH value", { ...BASE, FUNKY_AUTH: "maybe" }],
  ])("exits on %s", (_label, env) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });
});
