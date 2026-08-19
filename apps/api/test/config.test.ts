// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  FUNKY_AUTH_TOKEN: "0123456789abcdef",
};

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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
  it("applies defaults for a minimal environment", () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      port: 3000,
      dbPoolMax: 10,
      authToken: BASE.FUNKY_AUTH_TOKEN,
      namespaceSource: "static",
    });
  });

  it("FUNKY_AUTH=disabled yields a null token (and no token required)", () => {
    const cfg = loadConfig({ DATABASE_URL: BASE.DATABASE_URL, FUNKY_AUTH: "disabled" });
    expect(cfg.authToken).toBeNull();
  });

  it("namespace source defaults to static and parses header", () => {
    expect(loadConfig(BASE).namespaceSource).toBe("static");
    expect(loadConfig({ ...BASE, FUNKY_NAMESPACE_SOURCE: "header" }).namespaceSource).toBe(
      "header",
    );
  });
});

describe("loadConfig — invalid input", () => {
  it("exits when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ FUNKY_AUTH_TOKEN: BASE.FUNKY_AUTH_TOKEN })).toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when auth is enabled (the default) but no token is set", () => {
    expect(() => loadConfig({ DATABASE_URL: BASE.DATABASE_URL })).toThrow("process.exit(1)");
  });

  it("exits on a short token", () => {
    expect(() => loadConfig({ ...BASE, FUNKY_AUTH_TOKEN: "short" })).toThrow("process.exit(1)");
  });

  it("exits when the header source is combined with disabled auth", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: BASE.DATABASE_URL,
        FUNKY_AUTH: "disabled",
        FUNKY_NAMESPACE_SOURCE: "header",
      }),
    ).toThrow("process.exit(1)");
  });
});
