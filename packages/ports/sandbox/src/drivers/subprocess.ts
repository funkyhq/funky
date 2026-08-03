// packages/ports/sandbox/src/drivers/subprocess.ts — spawn-on-host dev driver.
//
// The idemKey shell protocol, implemented EXACTLY as the port contract requires so it
// matches every future driver: the filesystem IS the shared state. exec and attach both
// tail the same `out`/`exit` files, so two concurrent readers of one running command
// converge naturally — there is no subscriber registry, no in-memory coordination. Let
// the filesystem be the bus.
//
// v1 simplifications (intentional, not gaps — see the handoff's non-goals): reboot is a
// no-op (the FS is just a directory), and stderr is folded into stdout via `2>&1` (the
// `stderr` ExecEvent variant exists for future drivers; subprocess emits stdout + exit).

import { spawn } from "node:child_process";
import { type FileHandle, open } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedEnv } from "@funky/db/schema";
import { type ExecEvent, type Executor, type SandboxDriver, type SandboxHandle, SandboxGoneError, SandboxUnavailableError } from "../port";

const ROOT = "/tmp/funky";
const MAX_OUTPUT_BYTES = 200_000;
const POLL_MS = 100;

export class SubprocessDriver implements SandboxDriver {
  async provision(spec: ResolvedEnv, sessionId: string): Promise<SandboxHandle> {
    if (spec.network.type === "limited") {
      throw new Error("subprocess driver does not support limited network policies");
    }
    const workdir = path.join(ROOT, sessionId);
    await fs.mkdir(workdir, { recursive: true });
    return { driver: "subprocess", workdir };
  }

  // Reboot is a no-op: the persistent FS is just `workdir`, so it survives trivially.
  async reboot(handle: SandboxHandle): Promise<SandboxHandle> {
    return handle;
  }

  // rm -rf, force ignores ENOENT → calling teardown twice never throws.
  async teardown(handle: SandboxHandle): Promise<void> {
    await fs.rm(workdirOf(handle), { recursive: true, force: true });
  }

  connect(handle: SandboxHandle): Executor {
    return new SubprocessExecutor(workdirOf(handle));
  }
}

class SubprocessExecutor implements Executor {
  constructor(private readonly workdir: string) {}

  exec(req: { cmd: string; idemKey: string; timeoutMs?: number }): AsyncIterable<ExecEvent> {
    const { workdir } = this;
    return (async function* () {
      // No workdir → torn down (or never provisioned). The local filesystem answered
      // definitively, so this is GONE — positive evidence, never a synthesized exit code.
      if (!(await exists(workdir))) throw new SandboxGoneError("sandbox is not provisioned");
      const funkyRoot = path.join(workdir, ".funky");
      await fs.mkdir(funkyRoot, { recursive: true });
      const dir = path.join(funkyRoot, req.idemKey);

      // Atomic first-run detection: mkdir(dir) is the lock. Success → we own this run and
      // spawn. EEXIST → someone already started this idemKey; fall through to attach
      // semantics (tail the shared files). Either way exactly one process is spawned.
      let firstRun = false;
      try {
        await fs.mkdir(dir);
        firstRun = true;
      } catch (err) {
        if (errno(err) !== "EEXIST") throw err;
      }
      if (firstRun) spawnCommand(workdir, dir, req.cmd, req.timeoutMs);
      yield* tail(dir);
    })();
  }

  attach(idemKey: string): AsyncIterable<ExecEvent> {
    const dir = path.join(this.workdir, ".funky", idemKey);
    return (async function* () {
      // Nothing recorded under this idemKey → no result to observe: infrastructure error.
      if (!(await exists(dir))) throw new SandboxUnavailableError(`no running command for idemKey: ${idemKey}`);
      yield* tail(dir);
    })();
  }

  async readFile(p: string): Promise<Uint8Array> {
    return await fs.readFile(this.resolveInside(p));
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    const abs = this.resolveInside(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }

  // Reject paths escaping the workdir (absolute paths, `..` traversal, the workdir itself).
  private resolveInside(p: string): string {
    const abs = path.resolve(this.workdir, p);
    const rel = path.relative(this.workdir, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes the sandbox: ${p}`);
    }
    return abs;
  }
}

// ---------------------------------------------------------------------------
// The spawn: `sh -c '(<cmd>) > out 2>&1; echo $? > exit'`. The `exit` file is the
// completion marker; readers tail `out` until it appears. detached + process-group kill
// on timeout so orphaned `sleep`s can't survive teardown.
// ---------------------------------------------------------------------------
function spawnCommand(workdir: string, dir: string, cmd: string, timeoutMs?: number): void {
  const outPath = path.join(dir, "out");
  const exitPath = path.join(dir, "exit");
  const script = `(${cmd}) > ${shq(outPath)} 2>&1; echo $? > ${shq(exitPath)}`;
  const child = spawn("sh", ["-c", script], {
    cwd: workdir, // commands run inside the sandbox, not the host's cwd
    detached: true, // own process group so we can kill the whole tree on timeout
    stdio: "ignore",
  });
  child.unref();

  if (timeoutMs && timeoutMs > 0) {
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      // Only stamp 124 if the command didn't finish first (bash timeout convention).
      exists(exitPath).then((done) => {
        if (!done) void fs.writeFile(exitPath, "124\n").catch(() => {});
      });
    }, timeoutMs);
    child.on("exit", () => clearTimeout(timer));
  }
}

// tail streams `out` from byte 0, polling until `exit` appears with a parseable code.
// A fresh tail (exec first-run OR a later attach) re-reads from the start, so every
// reader sees the full output — the files are the single source of truth.
async function* tail(dir: string): AsyncGenerator<ExecEvent> {
  const outPath = path.join(dir, "out");
  const exitPath = path.join(dir, "exit");
  let offset = 0;
  let total = 0;
  let truncated = false;

  // Emit any bytes appended since `offset`, clipping the total stream at MAX_OUTPUT_BYTES.
  async function* drain(): AsyncGenerator<ExecEvent> {
    const { data, size } = await readSlice(outPath, offset);
    if (size <= offset) return;
    offset = size;
    if (truncated) return; // still advance offset, but stop yielding once clipped
    let buf = data;
    if (total + buf.length > MAX_OUTPUT_BYTES) {
      buf = buf.subarray(0, MAX_OUTPUT_BYTES - total);
      truncated = true;
    }
    if (buf.length > 0) {
      total += buf.length;
      yield { kind: "stdout", data: buf.toString("utf8") };
    }
  }

  for (;;) {
    yield* drain();
    if (await exists(exitPath)) {
      const code = await readExitCode(exitPath);
      if (code !== null) {
        yield* drain(); // final flush: bytes written between the last read and `exit`
        yield { kind: "exit", code, truncated };
        return;
      }
      // `exit` file created but not yet written — keep polling.
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Small fs helpers. None of these leak the workdir path upward — errors surfaced from
// exec/attach never mention it (it's a driver-internal detail, like the opaque handle).
// ---------------------------------------------------------------------------
async function readSlice(p: string, offset: number): Promise<{ data: Buffer; size: number }> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(p, "r");
    const { size } = await fh.stat();
    if (size <= offset) return { data: Buffer.alloc(0), size };
    const data = Buffer.alloc(size - offset);
    await fh.read(data, 0, data.length, offset);
    return { data, size };
  } catch (err) {
    if (errno(err) === "ENOENT") return { data: Buffer.alloc(0), size: offset }; // not created yet
    throw err;
  } finally {
    await fh?.close();
  }
}

async function readExitCode(p: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(p, "utf8")).trim();
    if (raw === "") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function workdirOf(handle: SandboxHandle): string {
  const w = (handle as { workdir?: unknown }).workdir;
  if (typeof w !== "string") throw new Error("not a subprocess sandbox handle");
  return w;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

// Single-quote a path for `sh -c`, escaping embedded single quotes.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
