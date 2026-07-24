// The ComputeSDK driver runs the identical conformance suite twice:
//
// 1. "computesdk/local-shell" — always. A fake provider whose sandbox is a temp dir and
//    whose runCommand is a local `sh -c`, faithful to the e2b provider's error surface
//    (it NEVER throws; transport failures come back as exitCode 127 with the message in
//    stderr; getById returns null once destroyed). This exercises the driver's whole
//    shell protocol — the mkdir lock, the detached runner, the poll envelope, base64
//    file i/o, in-sandbox timeout — through a real shell, keyless, in CI.
//
// 2. "computesdk/e2b" — against real E2B sandboxes when a key is present (skipped
//    otherwise), with generous timeouts: every case provisions its own remote sandbox
//    and every poll is a network round-trip.
//
//      E2B_API_KEY=e2b_... pnpm -F @funky/sandbox test

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { e2b } from "@computesdk/e2b";
import type { CommandResult, CreateSandboxOptions, SandboxInterface } from "computesdk";
import { describe, expect, it } from "vitest";
import { type ComputeProvider, ComputeSdkDriver } from "./drivers/computesdk";
import { runSandboxTck } from "./tck";

const sh = promisify(execFile);

runSandboxTck(
  "computesdk/local-shell",
  () => new ComputeSdkDriver({ providerName: "fake-local", provider: localShellProvider() }),
  { timeoutMs: 20_000 },
);

const apiKey = process.env.E2B_API_KEY;
if (apiKey) {
  runSandboxTck(
    "computesdk/e2b",
    () =>
      new ComputeSdkDriver({
        providerName: "e2b",
        provider: e2b({ apiKey }),
        sandboxTimeoutMs: 5 * 60_000, // TCK sandboxes are short-lived
      }),
    { timeoutMs: 120_000 },
  );
} else {
  describe("sandbox TCK: computesdk/e2b", () => {
    it.skip("skipped: E2B_API_KEY is not set", () => {});
  });
}

// The create options are the one part of the driver a passing TCK cannot cover: the fake
// provider ignores them, so a wrong option name still runs green everywhere while silently
// doing nothing in production. ComputeSDK's CreateSandboxOptions ends in `[key: string]: any`
// and its e2b provider spreads unrecognised keys into E2BSandbox.create(), so tsc won't catch
// a typo either. These assert the exact shape we hand the provider.
describe("ComputeSDK sandbox lifecycle", () => {
  it("asks the provider to pause on timeout, not kill", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    const driver = new ComputeSdkDriver({
      providerName: "e2b",
      provider: localShellProvider((options) => {
        createOptions = options;
      }),
      sandboxTimeoutMs: 30 * 60_000,
    });

    const handle = await driver.provision({ network: { type: "unrestricted" } }, randomUUID());
    try {
      // Matches the e2b SDK's SandboxOpts.lifecycle. `autoPause` — the name this used to
      // pass — is NOT a field there; E2B ignored it and fell back to onTimeout:'kill',
      // destroying the filesystem at the timeout instead of pausing it.
      expect(createOptions?.lifecycle).toEqual({ onTimeout: "pause", autoResume: true });
      expect(createOptions).not.toHaveProperty("autoPause");
      expect(createOptions?.timeout).toBe(30 * 60_000);
    } finally {
      await driver.teardown(handle);
    }
  });
});

describe("ComputeSDK network policies", () => {
  it("maps a limited policy to E2B allowOut", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    const driver = new ComputeSdkDriver({
      providerName: "e2b",
      provider: localShellProvider((options) => {
        createOptions = options;
      }),
    });

    const handle = await driver.provision(
      { network: { type: "limited", allowed_hosts: ["api.example.com", "*.example.org"] } },
      randomUUID(),
    );
    try {
      expect(createOptions?.network).toEqual({
        allowOut: ["api.example.com", "*.example.org"],
      });
    } finally {
      await driver.teardown(handle);
    }
  });

  it("fails closed when a provider cannot enforce a limited policy", async () => {
    const driver = new ComputeSdkDriver({
      providerName: "fake-local",
      provider: localShellProvider(),
    });

    await expect(
      driver.provision(
        { network: { type: "limited", allowed_hosts: ["api.example.com"] } },
        randomUUID(),
      ),
    ).rejects.toThrow("fake-local does not support limited network policies");
  });
});

// ---------------------------------------------------------------------------
// The fake provider. One Map entry per "sandbox": a temp dir that plays $HOME.
// ---------------------------------------------------------------------------
function localShellProvider(onCreate?: (options?: CreateSandboxOptions) => void): ComputeProvider {
  const roots = new Map<string, { home: string; destroyed: boolean }>();
  const pathPrefix = timeoutShimPathPrefix();

  function makeSandbox(id: string): SandboxInterface {
    const runCommand = async (command: string): Promise<CommandResult> => {
      const t0 = Date.now();
      const s = roots.get(id);
      if (!s || s.destroyed) {
        // What the e2b provider returns once its caught transport error surfaces.
        return { stdout: "", stderr: `sandbox ${id} not found`, exitCode: 127, durationMs: 0 };
      }
      try {
        const { stdout, stderr } = await sh("sh", ["-c", command], {
          env: { ...process.env, HOME: s.home, PATH: pathPrefix + (process.env.PATH ?? "") },
          maxBuffer: 16 * 1024 * 1024,
        });
        return { stdout, stderr, exitCode: 0, durationMs: Date.now() - t0 };
      } catch (err) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr || (e.message ?? String(err)),
          exitCode: typeof e.code === "number" ? e.code : 127,
          durationMs: Date.now() - t0,
        };
      }
    };
    const unused = (what: string) => async (): Promise<never> => {
      throw new Error(`${what} is not used by the driver`);
    };
    return {
      sandboxId: id,
      provider: "fake-local",
      runCommand,
      getInfo: async () => ({
        id,
        provider: "fake-local",
        status: "running" as const,
        createdAt: new Date(),
        timeout: 0,
      }),
      getUrl: unused("getUrl"),
      destroy: async () => {
        const s = roots.get(id);
        if (s) s.destroyed = true;
      },
      filesystem: {
        readFile: unused("filesystem.readFile"),
        writeFile: unused("filesystem.writeFile"),
        readdir: unused("filesystem.readdir"),
        mkdir: unused("filesystem.mkdir"),
        exists: unused("filesystem.exists"),
        remove: unused("filesystem.remove"),
      },
    };
  }

  return {
    name: "fake-local",
    sandbox: {
      create: async (options) => {
        onCreate?.(options);
        const id = randomUUID();
        roots.set(id, { home: mkdtempSync(join(tmpdir(), "funky-csdk-")), destroyed: false });
        return makeSandbox(id);
      },
      getById: async (id) => {
        const s = roots.get(id);
        return s && !s.destroyed ? makeSandbox(id) : null;
      },
      destroy: async (id) => {
        const s = roots.get(id);
        if (s) {
          s.destroyed = true;
          rmSync(s.home, { recursive: true, force: true });
        }
      },
    },
  };
}

// GNU timeout(1) exists on Linux (and inside E2B sandboxes); macOS lacks it. Shim it for
// local runs so the in-sandbox timeout path is exercised everywhere: TERM the command
// after the duration and report 124, like the real thing.
function timeoutShimPathPrefix(): string {
  if (spawnSync("sh", ["-c", "command -v timeout"]).status === 0) return "";
  const bin = mkdtempSync(join(tmpdir(), "funky-timeout-shim-"));
  const shim = join(bin, "timeout");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'd="$1"; shift',
      '"$@" &',
      "pid=$!",
      '( sleep "$d"; kill -TERM "$pid" 2>/dev/null ) &',
      "w=$!",
      'wait "$pid"',
      "code=$?",
      'kill "$w" 2>/dev/null',
      '[ "$code" -eq 143 ] && exit 124',
      'exit "$code"',
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  return `${bin}:`;
}
