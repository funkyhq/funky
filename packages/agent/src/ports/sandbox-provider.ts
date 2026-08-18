// The SandboxProvider port
//
// The port is session-agnostic — sandboxes are addressed by sandboxId,
// and the session mapping is data, not interface: the driver creates
// with metadata {sessionId} and finds with list({metadata}). The
// ratified ensure-on-claim lifecycle is therefore a driver-side helper
// composed from list/connect/create, not a port method.
//
// Contract for implementations:
// - `create`'s timeout is a TTL the provider enforces on its own — the
//   lifecycle action fires even if every worker vanished, which makes
//   the TTL the garbage-collection backstop for missed stops.
// - `pause` frees compute and preserves the workspace FILESYSTEM;
//   whether in-memory state survives is backend-dependent (E2B
//   preserves it, docker does not) and callers must not rely on it.
// - `connect` reattaches to a running sandbox and throws otherwise;
//   `resume` revives a paused one and is idempotent on a running one,
//   so find-or-revive needs no state check between list and resume.
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

export interface SandboxProvider {
  create(opts?: CreateSandboxOptions): Promise<Sandbox>;
  /** Reattach to a running sandbox; throws if paused or unknown. */
  connect(sandboxId: string): Promise<Sandbox>;
  /** Revive a paused sandbox and reattach; idempotent on a running one. */
  resume(sandboxId: string): Promise<Sandbox>;
  /** Every non-killed sandbox, optionally filtered by metadata equality. */
  list(filter?: { metadata?: Record<string, string> }): Promise<SandboxInfo[]>;
}

export interface CreateSandboxOptions {
  /** TTL until the provider applies `lifecycle` by itself. */
  timeoutMs?: number;
  /** What the TTL does: pause (keep the workspace) or kill. Default "pause". */
  lifecycle?: "pause" | "kill";
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
