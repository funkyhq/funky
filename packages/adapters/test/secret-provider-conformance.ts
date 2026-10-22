// The SecretProvider conformance suite — the port's contract as executable
// tests, written against the interface via a factory. Every adapter runs
// this identical suite; what it pins is contract, what it doesn't pin is
// implementation freedom.
//
// Each test works in fresh namespaces of its own and deletes what it put,
// so the suite can run against a real, shared secret manager without
// colliding with another run or with anyone's keys.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretNotFoundError, type SecretProvider } from "@funky/agent";

export function describeSecretProviderConformance(
  name: string,
  makeProvider: () => Promise<SecretProvider>,
): void {
  describe(`SecretProvider conformance: ${name}`, () => {
    let secrets: SecretProvider;
    let ns: string;
    const used = new Set<string>();

    function namespace(): string {
      const fresh = `conformance-${randomUUID()}`;
      used.add(fresh);
      return fresh;
    }

    beforeEach(async () => {
      secrets = await makeProvider();
      ns = namespace();
    });

    afterEach(async () => {
      for (const namespace of used) {
        for (const { name } of await secrets.list(namespace)) {
          await secrets.delete({ namespace, name });
        }
      }
      used.clear();
    });

    it("resolves what was put, and lists it without the value", async () => {
      const info = await secrets.put({ namespace: ns, name: "stripe-live" }, "sk_live_1");
      expect(info).toEqual({
        name: "stripe-live",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(Date.parse(info.createdAt)).not.toBeNaN();
      expect(Date.parse(info.updatedAt)).toBeGreaterThanOrEqual(Date.parse(info.createdAt));

      await expect(secrets.resolve(ns, ["stripe-live"])).resolves.toEqual(
        new Map([["stripe-live", "sk_live_1"]]),
      );
      const listed = await secrets.list(ns);
      expect(listed).toEqual([info]);
      expect(JSON.stringify(listed)).not.toContain("sk_live_1");
    });

    it("replaces on a second put, keeping createdAt", async () => {
      const ref = { namespace: ns, name: "github-token" };
      const first = await secrets.put(ref, "ghp_old");
      const second = await secrets.put(ref, "ghp_new");

      expect(second.createdAt).toBe(first.createdAt);
      expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
      await expect(secrets.resolve(ns, ["github-token"])).resolves.toEqual(
        new Map([["github-token", "ghp_new"]]),
      );
      expect(await secrets.list(ns)).toEqual([second]);
    });

    it("rejects a resolve naming every missing name, and only those", async () => {
      await secrets.put({ namespace: ns, name: "present" }, "v");

      const error = await secrets
        .resolve(ns, ["absent-b", "present", "absent-a", "absent-b"])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretNotFoundError);
      const notFound = error as SecretNotFoundError;
      expect(notFound.namespace).toBe(ns);
      expect([...notFound.names].sort()).toEqual(["absent-a", "absent-b"]);
    });

    it("resolves no names to an empty map, and a repeated name once", async () => {
      await expect(secrets.resolve(ns, [])).resolves.toEqual(new Map());

      await secrets.put({ namespace: ns, name: "k" }, "v");
      await expect(secrets.resolve(ns, ["k", "k"])).resolves.toEqual(new Map([["k", "v"]]));
    });

    it("deletes once: true, then false, and the name stops resolving", async () => {
      const ref = { namespace: ns, name: "pg-password" };
      await secrets.put(ref, "hunter2");

      await expect(secrets.delete(ref)).resolves.toBe(true);
      await expect(secrets.delete(ref)).resolves.toBe(false);
      await expect(secrets.resolve(ns, ["pg-password"])).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
      expect(await secrets.list(ns)).toEqual([]);
    });

    it("lists a namespace's names sorted, and an unused namespace as empty", async () => {
      for (const name of ["b-key", "c-key", "a-key"]) {
        await secrets.put({ namespace: ns, name }, `value of ${name}`);
      }

      expect((await secrets.list(ns)).map((s) => s.name)).toEqual(["a-key", "b-key", "c-key"]);
      expect(await secrets.list(namespace())).toEqual([]);
    });

    it("keeps namespaces apart: another namespace's name is unknown", async () => {
      const other = namespace();
      await secrets.put({ namespace: ns, name: "shared-name" }, "mine");

      await expect(secrets.resolve(other, ["shared-name"])).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
      expect(await secrets.list(other)).toEqual([]);
      await expect(secrets.delete({ namespace: other, name: "shared-name" })).resolves.toBe(false);

      // The same name in two namespaces is two secrets.
      await secrets.put({ namespace: other, name: "shared-name" }, "theirs");
      await expect(secrets.resolve(ns, ["shared-name"])).resolves.toEqual(
        new Map([["shared-name", "mine"]]),
      );
      await expect(secrets.resolve(other, ["shared-name"])).resolves.toEqual(
        new Map([["shared-name", "theirs"]]),
      );
    });

    it("stores values verbatim", async () => {
      const values = {
        spaced: "  Bearer sk-ünïcödé/+=_-.~:@ ✓  ",
        long: "x".repeat(4096),
      };
      for (const [name, value] of Object.entries(values)) {
        await secrets.put({ namespace: ns, name }, value);
      }

      await expect(secrets.resolve(ns, Object.keys(values))).resolves.toEqual(
        new Map(Object.entries(values)),
      );
    });
  });
}
