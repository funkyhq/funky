// The Infisical adapter against an in-process fake of Infisical's API
// (fixtures/fake-infisical.ts): the conformance suite, then what only
// this adapter does — values stored as given and the value rules' breaks
// refused, reads kept to one folder, a namespace's folder made on its
// first put, the token renewed when
// Infisical rejects it, a 404 believed only once the environment is
// known, no failure but absence ever SecretNotFoundError, and what only
// an operator can fix a ProviderConfigError.
// infisical-live.test.ts runs the suite against a real Infisical.

import { beforeEach, describe, expect, test } from "vitest";
import { ProviderConfigError, SecretNotFoundError } from "@funky/agent";
import {
  createInfisicalSecretProvider,
  type InfisicalSecretProviderOptions,
} from "../src/secrets/infisical";
import { createFakeInfisical, FAKE_INFISICAL, type FakeInfisical } from "./fixtures/fake-infisical";
import { describeSecretProviderConformance } from "./secret-provider-conformance";

const shared = createFakeInfisical();
describeSecretProviderConformance("infisical (fake)", async () =>
  createInfisicalSecretProvider({ ...FAKE_INFISICAL, fetch: shared.fetch }),
);

describe("createInfisicalSecretProvider", () => {
  let infisical: FakeInfisical;
  const ref = { namespace: "acme", name: "token" };

  beforeEach(() => {
    infisical = createFakeInfisical();
  });

  function provider(overrides?: Partial<InfisicalSecretProviderOptions>) {
    return createInfisicalSecretProvider({
      ...FAKE_INFISICAL,
      fetch: infisical.fetch,
      ...overrides,
    });
  }

  function calls(): string[] {
    return infisical.requests.map((r) => `${r.method} ${r.path}`);
  }

  test("stores values as given, and refuses one breaking the value rules without sending it", async () => {
    const secrets = provider();
    await secrets.put(ref, "Bearer sk-ünï ✓");
    expect(infisical.stored("/acme", "token")).toBe("Bearer sk-ünï ✓");

    const sent = infisical.requests.length;
    await expect(secrets.put(ref, "sk_live_1\n")).rejects.toThrow("it has whitespace at an end");
    await expect(secrets.put(ref, "prefix ${OTHER}")).rejects.toThrow("it contains ${");
    expect(infisical.requests).toHaveLength(sent);
  });

  test("reads one folder: values only to resolve, no reference expanded, no import followed", async () => {
    const secrets = provider();
    await secrets.put(ref, "v");
    await secrets.list("acme");
    await secrets.resolve("acme", ["token"]);
    await secrets.resolve("acme", []);

    const common = {
      projectId: FAKE_INFISICAL.projectId,
      environment: FAKE_INFISICAL.environment,
      secretPath: "/acme",
      expandSecretReferences: "false",
      includeImports: "false",
      recursive: "false",
    };
    expect(
      infisical.requests.filter((r) => r.method === "GET").map((r) => Object.fromEntries(r.query)),
    ).toEqual([
      { ...common, viewSecretValue: "false" },
      { ...common, viewSecretValue: "true" },
    ]);
  });

  test("makes a namespace's folder on its first put, under the configured path", async () => {
    const secrets = provider({ path: "/funky/tenants/" });
    await secrets.put({ namespace: "acme", name: "a" }, "1");
    await secrets.put({ namespace: "acme", name: "b" }, "2");

    expect(calls()).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "PATCH /api/v4/secrets/batch", // 404: no folder yet
      "POST /api/v2/folders",
      "PATCH /api/v4/secrets/batch",
      "PATCH /api/v4/secrets/batch",
    ]);
    expect(infisical.requests[2]?.body).toMatchObject({ name: "acme", path: "/funky/tenants" });
    expect(infisical.stored("/funky/tenants/acme", "b")).toBe("2");
  });

  test("writes again after losing a race: to make the folder (400), or to create the name (500)", async () => {
    const secrets = provider();
    await Promise.all([
      secrets.put({ namespace: "acme", name: "a" }, "1"),
      secrets.put({ namespace: "acme", name: "b" }, "2"),
    ]);
    expect(calls().filter((c) => c === "POST /api/v2/folders")).toHaveLength(2);

    infisical.failNext("PATCH /api/v4/secrets/batch", 500, { message: "Something went wrong" });
    await secrets.put({ namespace: "acme", name: "c" }, "3");

    await expect(secrets.resolve("acme", ["a", "b", "c"])).resolves.toEqual(
      new Map([
        ["a", "1"],
        ["b", "2"],
        ["c", "3"],
      ]),
    );
  });

  test("signs in once, and once more when Infisical rejects the token", async () => {
    const secrets = provider();
    await secrets.put(ref, "v");
    await secrets.list("acme");
    infisical.expireTokens();
    await Promise.all([secrets.list("acme"), secrets.resolve("acme", ["token"])]);

    expect(calls().filter((c) => c.endsWith("/login"))).toHaveLength(2);
  });

  test("believes a namespace's 404 once the project shows the environment, checked once", async () => {
    const secrets = provider();
    expect(await secrets.list("nobody")).toEqual([]);
    await expect(secrets.resolve("nobody", ["k"])).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(secrets.delete({ namespace: "nobody", name: "k" })).resolves.toBe(false);

    expect(calls().filter((c) => c.startsWith("GET /api/v1/projects/"))).toHaveLength(1);
  });

  test("throws on a wrong environment or project rather than reading it as empty", async () => {
    const wrongEnvironment = provider({ environment: "production" });
    const listed = wrongEnvironment.list("acme");
    await expect(listed).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(listed).rejects.toThrow('has no environment "production"');
    const error = await wrongEnvironment.resolve("acme", ["k"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretNotFoundError);
    // A put names the folder's refusal, the cause of the write's 404.
    await expect(wrongEnvironment.put(ref, "v")).rejects.toThrow(
      "404 to POST /api/v2/folders: Environment not found",
    );

    const wrongProject = provider({ projectId: "nope" }).resolve("acme", ["k"]);
    await expect(wrongProject).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(wrongProject).rejects.toThrow("Infisical has no project nope");
  });

  test("a refused sign-in, or access a fresh token doesn't cure, is a config error", async () => {
    const signIn = provider({ clientSecret: "revoked" }).resolve("acme", ["token"]);
    await expect(signIn).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(signIn).rejects.toThrow("Infisical refused the sign-in: Infisical answered 401");

    // An identity without the permission: no token expired, so no second sign-in.
    const secrets = provider();
    const signIns = () => calls().filter((c) => c.endsWith("/login")).length - 1; // less the refused one
    infisical.failNext("GET /api/v4/secrets", 403, {
      error: "PermissionDenied",
      message: "You are not allowed to read on secrets",
    });
    const read = await secrets.resolve("acme", ["token"]).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(ProviderConfigError);
    expect(String(read)).toContain("403 to GET /api/v4/secrets: You are not allowed");
    expect(signIns()).toBe(1);

    // A token refused again straight after signing in.
    infisical.failNext("GET /api/v4/secrets", 401, { message: "stale" });
    infisical.failNext("GET /api/v4/secrets", 401, { message: "still" });
    await expect(secrets.list("acme")).rejects.toBeInstanceOf(ProviderConfigError);
    expect(signIns()).toBe(2);
  });

  test("a rate-limited sign-in is not a config error", async () => {
    infisical.failNext("POST /api/v1/auth/universal-auth/login", 429, { message: "slow down" });
    const error = await provider()
      .resolve("acme", ["token"])
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderConfigError);
    expect(String(error)).toContain("answered 429");
  });

  test("never reports an outage or a rate limit as SecretNotFoundError", async () => {
    const secrets = provider();
    for (const status of [503, 429]) {
      infisical.failNext("GET /api/v4/secrets", status, { message: "try later" });
      const error = await secrets.resolve("acme", ["token"]).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(SecretNotFoundError);
      expect(String(error)).toContain(`answered ${status} to GET /api/v4/secrets: try later`);
    }
  });

  test("resolves a value as edited in the Infisical dashboard, but not one hidden from it", async () => {
    const secrets = provider();
    await secrets.put(ref, "sk_live_1");
    infisical.edit("/acme", "token", "sk_live_rotated");
    await expect(secrets.resolve("acme", ["token"])).resolves.toEqual(
      new Map([["token", "sk_live_rotated"]]),
    );

    infisical.failNext("GET /api/v4/secrets", 200, {
      secrets: [
        {
          secretKey: "token",
          secretValue: "<hidden-by-infisical>",
          secretValueHidden: true,
          createdAt: "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:00:00.000Z",
        },
      ],
    });
    const hidden = secrets.resolve("acme", ["token"]);
    await expect(hidden).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(hidden).rejects.toThrow("can't read secret values");
  });

  test("throws when a change policy holds a write for approval", async () => {
    const secrets = provider();
    await secrets.put(ref, "v");

    infisical.failNext("PATCH /api/v4/secrets/batch", 200, { approval: { id: "approval-1" } });
    await expect(secrets.put(ref, "v2")).rejects.toThrow("for approval");
    infisical.failNext("DELETE /api/v4/secrets/token", 200, { approval: { id: "approval-2" } });
    await expect(secrets.delete(ref)).rejects.toThrow("for approval");
  });

  test("refuses, unasked, a namespace no folder can be named and a name Infisical would trim", async () => {
    const secrets = provider();
    await expect(secrets.list("a/b")).rejects.toThrow("can't name an Infisical folder");
    await expect(secrets.resolve("..", ["k"])).rejects.toThrow("can't name an Infisical folder");
    await expect(secrets.delete({ namespace: "a b", name: "k" })).rejects.toThrow(
      "can't name an Infisical folder",
    );
    await expect(secrets.put({ namespace: "acme", name: " token" }, "v")).rejects.toThrow(
      "trims names",
    );
    expect(infisical.requests).toEqual([]);
  });
});
