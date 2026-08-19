// The e2b adapter against real sandboxes — the behavior a mock can only
// assert by fiat: exit codes settling as results, byte round-trips,
// in-sandbox timeouts, metadata listing, and the pause → connect-revives
// → filesystem-survives cycle. Runs only when E2B_API_KEY is set
// (deliberate opt-in — every run creates a real sandbox):
//
//   E2B_API_KEY=... pnpm --filter @funky/adapters test e2b-live
//
// One sandbox serves the whole suite, serially; its TTL is lifecycle
// "kill" so an aborted run leaves no orphan behind.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { type Sandbox, SandboxNotFoundError, type SandboxProvider } from "@funky/agent";
import { createE2bProvider } from "../src/sandbox/e2b";

const apiKey = process.env.E2B_API_KEY;

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
  });
}
