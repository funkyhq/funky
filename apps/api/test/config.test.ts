// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  FUNKY_AUTH_TOKEN: "0123456789abcdef",
  E2B_API_KEY: "e2b_test",
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
      e2bApiKey: BASE.E2B_API_KEY,
      streamPollMs: 1000,
      streamHeartbeatMs: 15_000,
    });
  });

  it("coerces the stream pacing overrides", () => {
    const cfg = loadConfig({
      ...BASE,
      FUNKY_STREAM_POLL_MS: "250",
      FUNKY_STREAM_HEARTBEAT_MS: "5000",
    });
    expect(cfg.streamPollMs).toBe(250);
    expect(cfg.streamHeartbeatMs).toBe(5000);
  });

  it("FUNKY_AUTH=disabled yields a null token (and no token required)", () => {
    const cfg = loadConfig({
      DATABASE_URL: BASE.DATABASE_URL,
      E2B_API_KEY: BASE.E2B_API_KEY,
      FUNKY_AUTH: "disabled",
    });
    expect(cfg.authToken).toBeNull();
  });
});

describe("loadConfig — invalid input", () => {
  it("exits when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when E2B_API_KEY is missing — env config templates build on E2B", () => {
    const { E2B_API_KEY: _, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
  });

  it("exits when auth is enabled (the default) but no token is set", () => {
    const { FUNKY_AUTH_TOKEN: _, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
  });

  it("exits on a short token", () => {
    expect(() => loadConfig({ ...BASE, FUNKY_AUTH_TOKEN: "short" })).toThrow("process.exit(1)");
  });

  it("exits when the stream poll is slower than the heartbeat", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        FUNKY_STREAM_POLL_MS: "60000",
        FUNKY_STREAM_HEARTBEAT_MS: "15000",
      }),
    ).toThrow("process.exit(1)");
  });
});
