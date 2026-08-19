// The SandboxProvider port
//
// The port is session-agnostic — sandboxes are addressed by sandboxId.
// The session mapping lives in the Store (sessions.sandbox_id via the
// bindSandbox CAS); the {sessionId} metadata stamped at create is
// observability, not identity — a listing can never say which sandbox
// a session's committed history ran in. The ratified ensure-on-claim
// lifecycle is a driver-side helper composed from connect/create plus
// that CAS, not a port method.
//
// Contract for implementations:
// - `create`'s timeout is a TTL the provider enforces on its own — the
//   lifecycle action fires even if every worker vanished, which makes
//   the TTL the garbage-collection backstop for missed stops.
// - `pause` frees compute and preserves the workspace FILESYSTEM;
//   whether in-memory state survives is backend-dependent (E2B
//   preserves it, docker does not) and callers must not rely on it.
// - `connect` reattaches to a sandbox, reviving it in place when paused
//   (idempotent on a running one), so find-or-revive needs no state
//   check between list and connect. It throws only when the sandbox is
//   unknown or killed.
// - `run` executes through a shell; a non-zero exit is a result, never
//   a throw. Throwing means the sandbox itself was unreachable, after
//   one transparent recovery attempt. File content moves through
//   readFile/writeFile — never through shell-interpolated strings.
// - There is deliberately no abort signal: runaway commands are bounded
//   by the in-sandbox `timeoutMs` (and ultimately the TTL), which —
//   unlike a caller-held signal — also covers the caller vanishing
//   entirely. Correctness never needed the signal: an aborted step is
//   simply never committed, and the fence rejects late work.
// - `kill` destroys the sandbox including its workspace.

import type { NetworkPolicy } from "@funky/core";

/**
 * connect()'s "definitively gone" rejection: the sandbox no longer
 * exists (killed, or expired past recovery) — as opposed to being
 * unreachable. Rebinding a fresh sandbox over a dead one keys on this,
 * so adapters MUST throw it only on provider confirmation, never for a
 * transient failure — misclassifying an outage would abandon a live
 * workspace.
 */
export class SandboxNotFoundError extends Error {}

export interface SandboxProvider {
  create(opts?: CreateSandboxOptions): Promise<Sandbox>;
  /** Reattach, reviving a paused sandbox. Rejects with
   *  SandboxNotFoundError when the sandbox is unknown or killed. */
  connect(sandboxId: string): Promise<Sandbox>;
  /** Every non-killed sandbox, optionally filtered by metadata equality. */
  list(filter?: { metadata?: Record<string, string> }): Promise<SandboxInfo[]>;
}

export interface CreateSandboxOptions {
  /** TTL until the provider applies `lifecycle` by itself. */
  timeoutMs?: number;
  /** What the TTL does: pause (keep the workspace) or kill. Default "pause". */
  lifecycle?: "pause" | "kill";
  /** Egress intent (core/environment.ts). Adapters translate it to
   *  their provider's enforcement and MUST reject create() when they
   *  cannot enforce it — never silently run more open than asked.
   *  Absent = unrestricted. */
  network?: NetworkPolicy;
  /** Opaque labels; the driver stores the session mapping here. */
  metadata?: Record<string, string>;
}

export interface SandboxInfo {
  sandboxId: string;
  state: "running" | "paused";
  metadata: Record<string, string>;
}

export interface Sandbox {
  readonly sandboxId: string;
  getInfo(): Promise<SandboxInfo>;
  /** Run a shell command in the workspace (cwd defaults to its root). */
  run(command: string, opts?: RunOptions): Promise<CommandResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

export interface RunOptions {
  cwd?: string;
  /** Wall-clock bound enforced inside the sandbox, so a runaway command
   *  dies even if the caller vanishes. Default: the adapter's. */
  timeoutMs?: number;
  /** Incremental output taps. Fire-and-forget decoration. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
