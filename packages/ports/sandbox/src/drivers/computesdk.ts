// packages/ports/sandbox/src/drivers/computesdk.ts — remote sandboxes via ComputeSDK.
//
// The same idemKey shell protocol as subprocess — the filesystem is the bus — except the
// files live in a provider-hosted sandbox (E2B today) that OUTLIVES any worker. The
// runner script stamps `exit` from inside the sandbox, so an in-flight command keeps
// running and records its result even if the worker that started it dies; any replacement
// worker holding the handle attaches by idemKey and reads the same files. The command
// timeout runs in-sandbox too (`timeout(1)`, exit 124), never on a worker timer, for the
// same reason.
//
// Error mapping: ComputeSDK's runCommand NEVER throws — provider/transport errors come
// back as exitCode 127 with the message in stderr. Our wrapper scripts exit 0 on every
// legitimate path (the user command's exit code travels via the `exit` file, never via
// runCommand), so a non-zero WRAPPER exit means the result is unobservable → throw
// SandboxUnavailableError, exactly the port's "no exit code ⇒ throw" rule.

import * as posix from "node:path/posix";
import {
  type CallableCompute,
  type ExplicitComputeConfig,
  type SandboxInterface,
  compute,
} from "computesdk";
import type { ResolvedEnv } from "@funky/db/schema";
import {
  type ExecEvent,
  type Executor,
  type SandboxDriver,
  type SandboxHandle,
  SandboxUnavailableError,
} from "../port";

type Manager = ReturnType<CallableCompute>;
export type ComputeProvider = NonNullable<ExplicitComputeConfig["provider"]>;

const MAX_OUTPUT_BYTES = 200_000;
const POLL_MS = 250; // each poll is a network round-trip; slower than subprocess's 100ms
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60_000;

export type ComputeSdkDriverOptions = {
  /** Provider name; becomes the handle's `driver` tag (e.g. "e2b"). */
  providerName: string;
  /** A ComputeSDK provider instance, e.g. e2b({ apiKey }). */
  provider: ComputeProvider;
  /** Idle lifetime before the provider auto-pauses the sandbox — NOT a command timeout.
   *  A paused sandbox resumes (filesystem intact) on the next connect. */
  sandboxTimeoutMs?: number;
};

export class ComputeSdkDriver implements SandboxDriver {
  private readonly manager: Manager;
  private readonly providerName: string;
  private readonly sandboxTimeoutMs: number;

  constructor(opts: ComputeSdkDriverOptions) {
    this.manager = compute({ provider: opts.provider });
    this.providerName = opts.providerName;
    this.sandboxTimeoutMs = opts.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  }

  async provision(_spec: ResolvedEnv, sessionId: string): Promise<SandboxHandle> {
    // v1 parity with subprocess: spec.egress is not mapped yet — the provider boots its
    // default template. autoPause makes the timeout a pause (disk
    // persisted, resumed on connect) instead of a kill; that's what keeps reboot honest.
    const sb = await this.manager.sandbox.create({
      timeout: this.sandboxTimeoutMs,
      metadata: { funky_session_id: sessionId },
      autoPause: true,
    });
    // Resolve the workdir REMOTELY ($HOME varies by template). Markers around the path
    // guard against login-shell noise (motd, profile echoes) polluting stdout.
    const r = await sb.runCommand(`mkdir -p "$HOME/funky" && printf '@funky:%s@' "$HOME/funky"`);
    const m = /@funky:([^@]+)@/.exec(r.stdout);
    if (r.exitCode !== 0 || !m || !m[1]) {
      await this.manager.sandbox.destroy(sb.sandboxId).catch(() => {}); // don't leak it
      throw new Error(`sandbox workdir setup failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return { driver: this.providerName, sandboxId: sb.sandboxId, workdir: m[1] };
  }

  // Reconnect: a paused sandbox auto-resumes with its filesystem intact, so the handle
  // stays valid as-is. A sandbox that is fatally gone (killed, expired) cannot be rebuilt
  // without losing the filesystem this method promises to keep — that is unavailability
  // (the turn loop's error policy takes it from here), never a silent fresh provision.
  async reboot(handle: SandboxHandle): Promise<SandboxHandle> {
    const h = parseHandle(handle, this.providerName);
    const sb = await this.manager.sandbox.getById(h.sandboxId).catch(() => null);
    if (!sb) throw new SandboxUnavailableError(`sandbox ${h.sandboxId} is gone (cannot reboot)`);
    return handle;
  }

  // ComputeSDK's destroy swallows provider errors (already-dead sandboxes included), so
  // calling teardown twice never throws.
  async teardown(handle: SandboxHandle): Promise<void> {
    const h = parseHandle(handle, this.providerName);
    await this.manager.sandbox.destroy(h.sandboxId);
  }

  connect(handle: SandboxHandle): Executor {
    const h = parseHandle(handle, this.providerName);
    return new ComputeSdkExecutor(this.manager, h.sandboxId, h.workdir);
  }
}

class ComputeSdkExecutor implements Executor {
  /** Cached connection, reset on failure so a later call retries fresh. */
  private sb: Promise<SandboxInterface> | null = null;

  constructor(
    private readonly manager: Manager,
    private readonly sandboxId: string,
    private readonly workdir: string,
  ) {}

  // getById returns null for a dead sandbox AND for transport failures — both mean the
  // same thing here: we cannot observe anything, so SandboxUnavailableError.
  private sandbox(): Promise<SandboxInterface> {
    this.sb ??= this.manager.sandbox.getById(this.sandboxId).then(
      (sb) => {
        if (sb) return sb;
        this.sb = null;
        throw new SandboxUnavailableError(`sandbox ${this.sandboxId} is gone`);
      },
      (err) => {
        this.sb = null;
        throw new SandboxUnavailableError(
          `sandbox ${this.sandboxId} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    return this.sb;
  }

  exec(req: { cmd: string; idemKey: string; timeoutMs?: number }): AsyncIterable<ExecEvent> {
    const self = this;
    return (async function* () {
      const sb = await self.sandbox();
      const dir = keyDir(self.workdir, req.idemKey);
      // One round-trip: atomic mkdir lock + (winner only) write cmd/runner + spawn
      // detached. Losing the lock IS the attach path — the tail is identical either way.
      const r = await sb.runCommand(startScript(self.workdir, dir, req.cmd, req.timeoutMs));
      if (r.exitCode !== 0) throw unavailable(self.sandboxId, r);
      yield* tail(sb, self.sandboxId, dir);
    })();
  }

  attach(idemKey: string): AsyncIterable<ExecEvent> {
    const self = this;
    return (async function* () {
      const sb = await self.sandbox();
      const dir = keyDir(self.workdir, idemKey);
      // Nothing recorded under this idemKey → no result to observe. `test -d` failing
      // for transport reasons lands in the same class: unobservable.
      const r = await sb.runCommand(`test -d ${shq(dir)}`);
      if (r.exitCode !== 0) throw new SandboxUnavailableError(`no running command for idemKey: ${idemKey}`);
      yield* tail(sb, self.sandboxId, dir);
    })();
  }

  // File i/o rides runCommand + base64, not ComputeSDK's filesystem API: that API is
  // string-typed (utf8) and would corrupt binary content. Exit 127 is the provider's
  // caught-transport-error marker (a real shell reports a missing file as 1/2, a missing
  // binary as 127 — base64(1) is in every base image), so 127 → unavailable.
  async readFile(p: string): Promise<Uint8Array> {
    const abs = this.resolveInside(p);
    const sb = await this.sandbox();
    // `base64 < file`, not `base64 file`: BSD base64 (macOS, where the local-shell suite
    // runs) takes no file argument; stdin works everywhere.
    const r = await sb.runCommand(`base64 < ${shq(abs)}`);
    if (r.exitCode === 127) throw unavailable(this.sandboxId, r);
    if (r.exitCode !== 0) throw new Error(`readFile ${p}: ${r.stderr.trim()}`);
    return Buffer.from(r.stdout, "base64");
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    const abs = this.resolveInside(p);
    const sb = await this.sandbox();
    const b64 = Buffer.from(data).toString("base64");
    const r = await sb.runCommand(
      `mkdir -p ${shq(posix.dirname(abs))} && printf '%s' '${b64}' | base64 -d > ${shq(abs)}`,
    );
    if (r.exitCode === 127) throw unavailable(this.sandboxId, r);
    if (r.exitCode !== 0) throw new Error(`writeFile ${p}: ${r.stderr.trim()}`);
  }

  // Reject paths escaping the workdir — same rule as subprocess, POSIX flavor (these are
  // sandbox-side paths; the host's path semantics are irrelevant).
  private resolveInside(p: string): string {
    const abs = posix.resolve(this.workdir, p);
    const rel = posix.relative(this.workdir, abs);
    if (rel === "" || rel.startsWith("..") || posix.isAbsolute(rel)) {
      throw new Error(`path escapes the sandbox: ${p}`);
    }
    return abs;
  }
}

// ---------------------------------------------------------------------------
// The spawn, mirroring subprocess: `sh cmd > out 2>&1; echo $? > exit`, with `exit` as
// the completion marker. The command text travels base64-encoded — no shell-quoting rules
// to fight, any byte sequence survives. `if mkdir` is the atomic first-run lock; losing
// it exits 0 and the caller just tails. nohup + & detaches the runner from this
// runCommand, so it keeps going after the RPC returns.
// ---------------------------------------------------------------------------
function startScript(workdir: string, dir: string, cmd: string, timeoutMs?: number): string {
  const t = timeoutMs && timeoutMs > 0 ? `timeout ${timeoutMs / 1000} ` : "";
  const runner = [
    `cd ${shq(workdir)}`,
    `${t}sh ${shq(posix.join(dir, "cmd"))} > ${shq(posix.join(dir, "out"))} 2>&1`,
    `echo $? > ${shq(posix.join(dir, "exit"))}`,
  ].join("\n");
  return [
    `mkdir -p ${shq(posix.join(workdir, ".funky"))}`,
    `if mkdir ${shq(dir)} 2>/dev/null; then`,
    `printf '%s' '${b64(cmd)}' | base64 -d > ${shq(posix.join(dir, "cmd"))}`,
    `printf '%s' '${b64(runner)}' | base64 -d > ${shq(posix.join(dir, "run"))}`,
    `nohup sh ${shq(posix.join(dir, "run"))} >/dev/null 2>&1 &`,
    `fi`,
  ].join("\n");
}

// One poll round-trip emits a three-part envelope on stdout:
//   line 1: exit code, or empty while still running
//   line 2: total byte size of `out` (drives the truncated flag)
//   rest:   base64 of out[offset .. offset+cap)
// `exit` is read FIRST: `out` is complete before `exit` is stamped, so an exit code on
// line 1 guarantees the slice that follows is the final one — no drain race.
function pollScript(dir: string, offset: number, cap: number): string {
  const out = shq(posix.join(dir, "out"));
  const exit = shq(posix.join(dir, "exit"));
  return [
    `if [ -s ${exit} ]; then head -n 1 ${exit}; else echo; fi`,
    `if [ -f ${out} ]; then wc -c < ${out}; else echo 0; fi`,
    `if [ -f ${out} ]; then tail -c +${offset + 1} ${out} | head -c ${cap} | base64; fi`,
  ].join("\n");
}

async function* tail(sb: SandboxInterface, sandboxId: string, dir: string): AsyncGenerator<ExecEvent> {
  let offset = 0; // bytes of `out` already yielded; never exceeds MAX_OUTPUT_BYTES
  for (;;) {
    const r = await sb.runCommand(pollScript(dir, offset, MAX_OUTPUT_BYTES - offset));
    if (r.exitCode !== 0) throw unavailable(sandboxId, r);

    const lines = r.stdout.split("\n");
    const exitRaw = (lines[0] ?? "").trim();
    const size = Number.parseInt((lines[1] ?? "0").trim(), 10);
    // base64(1) wraps its output; joining the remaining lines undoes the wrapping.
    const chunk = Buffer.from(lines.slice(2).join(""), "base64");

    if (chunk.length > 0) {
      offset += chunk.length;
      yield { kind: "stdout", data: chunk.toString("utf8") };
    }
    const code = exitRaw === "" ? Number.NaN : Number.parseInt(exitRaw, 10);
    if (!Number.isNaN(code)) {
      // `exit` stamped but unparseable falls through and polls again, like subprocess.
      yield { kind: "exit", code, truncated: !Number.isNaN(size) && size > MAX_OUTPUT_BYTES };
      return;
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function keyDir(workdir: string, idemKey: string): string {
  return posix.join(workdir, ".funky", idemKey);
}

function unavailable(sandboxId: string, r: { exitCode: number; stderr: string }): SandboxUnavailableError {
  return new SandboxUnavailableError(
    `sandbox ${sandboxId} unreachable (wrapper exit ${r.exitCode}): ${r.stderr.trim()}`,
  );
}

function parseHandle(handle: SandboxHandle, providerName: string): { sandboxId: string; workdir: string } {
  const { sandboxId, workdir } = handle as { sandboxId?: unknown; workdir?: unknown };
  if (handle.driver !== providerName || typeof sandboxId !== "string" || typeof workdir !== "string") {
    throw new Error(`not a ${providerName} sandbox handle`);
  }
  return { sandboxId, workdir };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

// Single-quote for the shell, escaping embedded single quotes.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
