// loadConfig(env) is the single place env is parsed. It fails fast via
// process.exit(1); tests stub exit so the failure path is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const BASE = {
  DATABASE_URL: "postgres://funky:funky@localhost:5432/funky",
  FUNKY_AUTH_TOKEN: "0123456789abcdef",
};

const INFISICAL = {
  INFISICAL_CLIENT_ID: "5c4f1d3e-0000-4000-8000-000000000001",
  INFISICAL_CLIENT_SECRET: "fake-client-secret",
  INFISICAL_PROJECT_ID: "5c4f1d3e-0000-4000-8000-000000000002",
  INFISICAL_ENVIRONMENT: "dev",
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
      streamPollMs: 1000,
      streamHeartbeatMs: 15_000,
      infisical: null,
    });
  });

  it("reads an Infisical identity as the secret store", () => {
    expect(loadConfig({ ...BASE, ...INFISICAL }).infisical).toEqual({
      clientId: INFISICAL.INFISICAL_CLIENT_ID,
      clientSecret: INFISICAL.INFISICAL_CLIENT_SECRET,
      projectId: INFISICAL.INFISICAL_PROJECT_ID,
      environment: INFISICAL.INFISICAL_ENVIRONMENT,
    });
  });

  it("reads blank Infisical variables as unset, the way compose forwards unset ones", () => {
    const blank = Object.fromEntries(Object.keys(INFISICAL).map((key) => [key, ""]));
    expect(loadConfig({ ...BASE, ...blank }).infisical).toBeNull();
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
    const cfg = loadConfig({ DATABASE_URL: BASE.DATABASE_URL, FUNKY_AUTH: "disabled" });
    expect(cfg.authToken).toBeNull();
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

  it("exits when the stream poll is slower than the heartbeat", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        FUNKY_STREAM_POLL_MS: "60000",
        FUNKY_STREAM_HEARTBEAT_MS: "15000",
      }),
    ).toThrow("process.exit(1)");
  });

  it("exits on part of an Infisical identity, naming each missing variable", () => {
    const { INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET } = INFISICAL;
    expect(() => loadConfig({ ...BASE, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET })).toThrow(
      "process.exit(1)",
    );
    const printed = vi.mocked(console.error).mock.calls.flat().join("\n");
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
