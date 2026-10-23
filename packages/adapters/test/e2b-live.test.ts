// The e2b adapter against real sandboxes — the behavior a mock can only
// assert by fiat: exit codes settling as results, byte round-trips,
// in-sandbox timeouts, metadata listing, the pause → connect-revives
// → filesystem-survives cycle, an allowlist fencing egress, a
// credential's key set on requests outside the sandbox, and E2B's
// refusal of a create arriving typed. Runs only when E2B_API_KEY is set
// (deliberate opt-in — every run creates a real sandbox):
//
//   E2B_API_KEY=... pnpm --filter @funky/adapters test e2b-live
//
// One sandbox serves the whole suite, serially (the allowlist and
// credential tests make their own), and every TTL is lifecycle "kill" so
// an aborted run leaves no orphan behind. The credential tests use a
// made-up key and httpbin.org, which echoes the headers it receives.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import {
  type ResolvedCredential,
  type Sandbox,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxProvisionError,
} from "@funky/agent";
import { CREDENTIAL_PLACEHOLDER, createE2bProvider } from "../src/sandbox/e2b";

const apiKey = process.env.E2B_API_KEY;

/** A made-up key, sent as X-Api-Key to `domains`. */
function probeCredential(domains: string[], key: string): ResolvedCredential {
  return {
    credential: {
      type: "injected",
      env: "PROBE_KEY",
      secret: "probe",
      domains,
      header: "X-Api-Key",
      value: "Key {secret}",
    },
    key,
  };
}

if (!apiKey) {
  describe.skip("e2b sandbox provider (live)", () => {
    it("skipped — set E2B_API_KEY to run", () => {});
  });
} else {
  describe("e2b sandbox provider (live)", () => {
    const marker = `funky-e2b-live-${randomUUID()}`;
    let provider: SandboxProvider;
    let sandbox: Sandbox;

    beforeAll(async () => {
      provider = createE2bProvider({ apiKey });
      sandbox = await provider.create({
        timeoutMs: 300_000,
        lifecycle: "kill",
        metadata: { funkySuite: marker },
      });
    }, 120_000);

    afterAll(async () => {
      await sandbox?.kill().catch(() => {});
    }, 60_000);

    test("runs commands and settles non-zero exits as results", async () => {
      const ok = await sandbox.run("echo hello");
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("hello");

      const failed = await sandbox.run("echo boom >&2; exit 7");
      expect(failed.exitCode).toBe(7);
      expect(failed.stderr).toContain("boom");
    }, 60_000);

    test("honors cwd and streams output taps", async () => {
      const chunks: string[] = [];
      const result = await sandbox.run("pwd", { cwd: "/tmp", onStdout: (c) => chunks.push(c) });
      expect(result.stdout.trim()).toBe("/tmp");
      expect(chunks.join("")).toContain("/tmp");
    }, 60_000);

    test("bounds a runaway command by the in-sandbox timeout", async () => {
      const result = await sandbox.run("sleep 30", { timeoutMs: 2_000 });
      expect(result.exitCode).not.toBe(0);
    }, 60_000);

    test("round-trips text and binary through writeFile/readFile", async () => {
      await sandbox.writeFile("/home/user/notes.txt", "written by funky\n");
      const text = new TextDecoder().decode(await sandbox.readFile("/home/user/notes.txt"));
      expect(text).toBe("written by funky\n");

      const bytes = new Uint8Array([0, 1, 2, 255, 128, 0, 42]);
      await sandbox.writeFile("/home/user/blob.bin", bytes);
      expect(Array.from(await sandbox.readFile("/home/user/blob.bin"))).toEqual(Array.from(bytes));

      // The port's writeFile promise: missing parent directories are created.
      await sandbox.writeFile("/home/user/deep/nested/leaf.txt", "made the path\n");
      const nested = new TextDecoder().decode(
        await sandbox.readFile("/home/user/deep/nested/leaf.txt"),
      );
      expect(nested).toBe("made the path\n");
    }, 60_000);

    test("lists by metadata equality", async () => {
      const infos = await provider.list({ metadata: { funkySuite: marker } });
      expect(infos.map((info) => info.sandboxId)).toEqual([sandbox.sandboxId]);
      expect(infos[0]?.state).toBe("running");
      expect(infos[0]?.metadata.funkySuite).toBe(marker);
    }, 60_000);

    test("pause keeps the filesystem and connect revives", async () => {
      await sandbox.writeFile("/home/user/persist.txt", "survives pause\n");
      await sandbox.pause();

      const paused = await provider.list({ metadata: { funkySuite: marker } });
      expect(paused[0]?.state).toBe("paused");

      const revived = await provider.connect(sandbox.sandboxId);
      expect(revived.sandboxId).toBe(sandbox.sandboxId);
      const text = new TextDecoder().decode(await revived.readFile("/home/user/persist.txt"));
      expect(text).toBe("survives pause\n");

      // Idempotent on a running sandbox.
      const again = await provider.connect(sandbox.sandboxId);
      expect((await again.getInfo()).state).toBe("running");
      sandbox = revived;
    }, 240_000);

    test("kill removes the sandbox from list, and connect rejects as gone", async () => {
      await sandbox.kill();
      await expect(provider.list({ metadata: { funkySuite: marker } })).resolves.toEqual([]);
      // The port's typed "definitively gone" rejection — the signal
      // dead-binding recovery keys on.
      await expect(provider.connect(sandbox.sandboxId)).rejects.toBeInstanceOf(
        SandboxNotFoundError,
      );
    }, 60_000);

    test("an allowlist reaches its domains and nothing else", async () => {
      const fenced = await provider.create({
        timeoutMs: 120_000,
        lifecycle: "kill",
        network: { type: "allowlist", domains: ["example.com"] },
      });
      try {
        // A response, not a connect: E2B's firewall accepts a blocked TCP
        // connection before it decides, so only an HTTP status proves reach.
        const status = async (url: string) =>
          (await fenced.run(`curl -s -m 10 -o /dev/null -w '%{http_code}' ${url}`)).stdout;
        expect(await status("https://example.com")).toBe("200");
        expect(await status("https://example.org")).toBe("000");
      } finally {
        await fenced.kill().catch(() => {});
      }
    }, 120_000);

    test("a create E2B refuses rejects as a provision error", async () => {
      // A TTL over every plan's cap (1h Hobby, 24h Pro): E2B's 400, and no
      // sandbox is made. Should one ever be, it must not outlive the test.
      const refused = provider.create({ timeoutMs: 30 * 24 * 3_600_000, lifecycle: "kill" });
      refused.then((made) => made.kill()).catch(() => {});
      await expect(refused).rejects.toBeInstanceOf(SandboxProvisionError);
      await expect(refused).rejects.toThrow("E2B refused the sandbox: 400:");
    }, 60_000);

    test("a credential's key is set on its domains' requests, never in the sandbox", async () => {
      const key = `funky-live-${randomUUID()}`;
      const injecting = await provider.create({
        timeoutMs: 300_000,
        lifecycle: "kill",
        credentials: [probeCredential(["httpbin.org"], key)],
      });
      try {
        const run = (command: string) => injecting.run(command, { timeoutMs: 120_000 });
        // Its output, or, when it printed nothing, its error: a client
        // refusing the proxy's TLS fails the assertion with the reason.
        const out = async (command: string) => {
          const result = await run(command);
          return result.stdout.trim() || result.stderr.trim();
        };
        expect(await out("echo $PROBE_KEY")).toBe(CREDENTIAL_PLACEHOLDER);
        expect(await out("env")).not.toContain(key);

        // What the proxy sent, as httpbin.org echoes it — through each
        // client's own trust of the proxy's TLS: Node with NODE_OPTIONS
        // replaced (as tools do), and Python's requests and httpx, which
        // ship their own CA lists.
        const sent = `Key ${key}`;
        expect(
          await out('curl -s -m 20 https://httpbin.org/headers -H "X-Api-Key: Key $PROBE_KEY"'),
        ).toContain(`"X-Api-Key": "${sent}"`);
        expect(
          await out(
            `NODE_OPTIONS= node -e "fetch('https://httpbin.org/headers').then((r) => r.json()).then((j) => console.log(j.headers['X-Api-Key']))"`,
          ),
        ).toBe(sent);
        expect((await run("pip install -q requests httpx")).exitCode).toBe(0);
        for (const client of ["requests", "httpx"]) {
          expect(
            await out(
              `python3 -c "import ${client}; print(${client}.get('https://httpbin.org/headers', timeout=20).json()['headers']['X-Api-Key'])"`,
            ),
          ).toBe(sent);
        }
        // A host without a rule keeps its own certificate.
        expect(await out("curl -s -m 20 -o /dev/null -w '%{http_code}' https://example.com")).toBe(
          "200",
        );
      } finally {
        await injecting.kill().catch(() => {});
      }
    }, 300_000);

    test("a credential's rule works inside an allowlist, and opens nothing", async () => {
      const key = `funky-live-${randomUUID()}`;
      const fenced = await provider.create({
        timeoutMs: 120_000,
        lifecycle: "kill",
        network: { type: "allowlist", domains: ["httpbin.org"] },
        credentials: [probeCredential(["httpbin.org", "example.org"], key)],
      });
      try {
        const out = async (command: string) => (await fenced.run(command)).stdout.trim();
        expect(await out("curl -s -m 20 https://httpbin.org/headers")).toContain(
          `"X-Api-Key": "Key ${key}"`,
        );
        // The credential names example.org; the allowlist doesn't.
        expect(await out("curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.org")).toBe(
          "000",
        );
      } finally {
        await fenced.kill().catch(() => {});
      }
    }, 120_000);

    test("E2B's refusal of a credential arrives typed, without the key", async () => {
      const key = `funky-live-${randomUUID()}`;
      const domains = Array.from({ length: 11 }, (_, i) => `d${i}.example.com`);
      const refused = provider.create({
        timeoutMs: 60_000,
        lifecycle: "kill",
        credentials: [probeCredential(domains, key)],
      });
      refused.then((made) => made.kill()).catch(() => {});
      await expect(refused).rejects.toBeInstanceOf(SandboxProvisionError);
      await expect(refused).rejects.toThrow(
        "E2B refused the sandbox: 400: Network rules can have at most 10 domains.",
      );
      await expect(refused).rejects.not.toThrow(key);
    }, 60_000);
  });
}
