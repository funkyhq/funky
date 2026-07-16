// packages/ports/sandbox/src/tck.ts — the sandbox conformance suite.
//
// Exported so any driver runs the identical suite: subprocess in CI today, computesdk
// (or a container driver) later. A driver that passes all 8 cases honours the idemKey
// exec protocol — that's the contract the worker depends on. Invoke from a *.test.ts:
//
//   import { runSandboxTck } from "./tck";
//   runSandboxTck("subprocess", () => new SubprocessDriver());

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it as baseIt } from "vitest";
import { type ExecEvent, type Executor, type SandboxDriver, SandboxUnavailableError } from "./port";
import type { ResolvedEnv } from "@funky/db/schema";

const SPEC: ResolvedEnv = {
  egress: { allow: [] },
};

type Collected = { stdout: string; stderr: string; exit: { code: number; truncated: boolean } };

async function collect(it: AsyncIterable<ExecEvent>): Promise<Collected> {
  let stdout = "";
  let stderr = "";
  let exit = { code: -1, truncated: false };
  for await (const ev of it) {
    if (ev.kind === "stdout") stdout += ev.data;
    else if (ev.kind === "stderr") stderr += ev.data;
    else exit = { code: ev.code, truncated: ev.truncated };
  }
  return { stdout, stderr, exit };
}

export function runSandboxTck(
  name: string,
  makeDriver: () => SandboxDriver,
  opts?: { timeoutMs?: number }, // remote drivers provision + poll over the network
): void {
  const timeout = opts?.timeoutMs;
  const it = timeout === undefined ? baseIt : (n: string, fn: () => Promise<void>) => baseIt(n, { timeout }, fn);
  describe(`sandbox TCK: ${name}`, () => {
    // Every case provisions its own sandbox (unique sessionId) and registers teardown.
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c().catch(() => {});
    }, timeout);

    async function sandbox(): Promise<{ driver: SandboxDriver; handle: Awaited<ReturnType<SandboxDriver["provision"]>>; exec: Executor }> {
      const driver = makeDriver();
      const handle = await driver.provision(SPEC, randomUUID());
      cleanups.push(() => driver.teardown(handle));
      return { driver, handle, exec: driver.connect(handle) };
    }

    it("1. exec streams stdout and exits 0", async () => {
      const { exec } = await sandbox();
      const r = await collect(exec.exec({ cmd: "echo hello", idemKey: "k1" }));
      expect(r.stdout).toContain("hello");
      expect(r.exit.code).toBe(0);
      expect(r.exit.truncated).toBe(false);
    });

    it("2. exit codes propagate", async () => {
      const { exec } = await sandbox();
      const r = await collect(exec.exec({ cmd: "exit 3", idemKey: "k2" }));
      expect(r.exit.code).toBe(3);
    });

    it("3. dedupe: two concurrent execs of one idemKey run the command once", async () => {
      const { exec } = await sandbox();
      // The marker lives INSIDE the sandbox (commands run with cwd = the sandbox workdir)
      // and is read back through the port — no host-filesystem assumptions, so the case
      // holds for remote drivers too.
      const cmd = `echo shared; echo $$ >> marker; sleep 0.3`;
      // Both start ~together; whichever wins the mkdir spawns, the other attaches. The
      // filesystem is the bus, so both iterables observe the same output either way.
      const [a, b] = await Promise.all([
        collect(exec.exec({ cmd, idemKey: "k3" })),
        collect(exec.exec({ cmd, idemKey: "k3" })),
      ]);

      expect(a.stdout).toContain("shared");
      expect(b.stdout).toEqual(a.stdout);
      expect(a.exit.code).toBe(0);
      expect(b.exit.code).toBe(0);

      const marker = new TextDecoder().decode(await exec.readFile("marker"));
      const lines = marker.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1); // command body executed exactly once
    });

    it("4. attach after the exec iterator is dropped sees full output + exit", async () => {
      const { exec } = await sandbox();
      // Kick exec until the command has surely spawned (first stdout), then abandon it.
      // The detached process keeps running; attach re-reads the shared files from byte 0.
      const it = exec.exec({ cmd: "echo start; sleep 0.3; echo done", idemKey: "k4" });
      for await (const ev of it) {
        if (ev.kind === "stdout") break;
      }
      const r = await collect(exec.attach("k4"));
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("done");
      expect(r.exit.code).toBe(0);
    });

    it("5. attach to an unknown idemKey throws SandboxUnavailableError", async () => {
      const { exec } = await sandbox();
      // No result to observe → infrastructure error, never a synthesized exit code.
      await expect(collect(exec.attach("never-ran"))).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    it("6. output over 200KB is truncated", async () => {
      const { exec } = await sandbox();
      const r = await collect(exec.exec({ cmd: `head -c 300000 /dev/zero | tr '\\0' 'x'`, idemKey: "k6" }));
      expect(r.exit.truncated).toBe(true);
      expect(r.stdout.length).toBe(200_000);
    });

    it("7. teardown is idempotent; exec after teardown throws SandboxUnavailableError", async () => {
      const { driver, handle, exec } = await sandbox();
      await driver.teardown(handle);
      await driver.teardown(handle); // twice → no throw
      await expect(collect(exec.exec({ cmd: "echo hi", idemKey: "k7" }))).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      );
    });

    it("8. reboot preserves the filesystem", async () => {
      const { driver, handle } = await sandbox();
      const bytes = new TextEncoder().encode("persist me");
      await driver.connect(handle).writeFile("state.txt", bytes);

      const rebooted = await driver.reboot(handle);
      const read = await driver.connect(rebooted).readFile("state.txt");
      expect(new TextDecoder().decode(read)).toBe("persist me");
    });

    it("9. a command that ran and failed is a result, not an error", async () => {
      const { exec } = await sandbox();
      // Non-zero exit + stderr: the command RAN, so this yields an exit event (the model's
      // problem to react to) — it does NOT throw.
      const r = await collect(exec.exec({ cmd: "echo boom >&2; exit 7", idemKey: "k9" }));
      expect(r.exit.code).toBe(7);
      expect(r.stdout).toContain("boom"); // stderr folded into stdout via 2>&1 for v1
    });

    it("10. a timeout yields exit 124, it does not throw", async () => {
      const { exec } = await sandbox();
      const r = await collect(exec.exec({ cmd: "sleep 5", idemKey: "k10", timeoutMs: 200 }));
      expect(r.exit.code).toBe(124); // bash timeout convention — still a result, not an error
    });
  });
}
