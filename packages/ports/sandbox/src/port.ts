// packages/ports/sandbox/src/port.ts — the sandbox port (Phase B).
//
// Plain TypeScript interfaces, NOT proto/codegen: same-process contracts the worker
// (Phase E) imports directly. Drivers are selected by config at the entrypoint; the
// worker never imports a driver. The binding contract for every driver — including
// future container / computesdk drivers — is the idemKey exec protocol: calling exec
// (or attach) with an idemKey that is already running/finished MUST replay the existing
// output, never run the command twice. See src/tck.ts for the conformance suite.

import type { ResolvedEnv } from "@funky/db/schema";

/** Opaque outside its own driver: only the driver that produced a handle may read its
 *  fields. Persisted as jsonb on the session row; `driver` selects who can interpret it. */
export type SandboxHandle = { driver: string } & Record<string, unknown>;

export type ExecEvent =
  | { kind: "stdout"; data: string }
  | { kind: "stderr"; data: string }
  | { kind: "exit"; code: number; truncated: boolean };

export interface Executor {
  // exec runs cmd under idemKey. Calling exec OR attach with an idemKey that is already
  // running/finished MUST NOT run the command again — it streams the existing output.
  exec(req: { cmd: string; idemKey: string; timeoutMs?: number }): AsyncIterable<ExecEvent>;
  attach(idemKey: string): AsyncIterable<ExecEvent>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface SandboxDriver {
  provision(spec: ResolvedEnv, sessionId: string): Promise<SandboxHandle>;
  teardown(handle: SandboxHandle): Promise<void>; // idempotent
  connect(handle: SandboxHandle): Executor; //       sync; cheap; any worker from the handle
  // There is deliberately no reboot/repair operation: connect() must transparently reach
  // a live-or-paused sandbox (drivers resume on inbound traffic), and a sandbox that is
  // GONE cannot be repaired without losing the filesystem — that is SandboxGoneError,
  // the caller's policy problem, never a driver-internal fresh provision.
}

/** Thrown when the Executor cannot OBSERVE a command's result — sandbox unreachable,
 *  connection dropped, executord dead. This is NOT how a command that RAN and failed is
 *  reported: a non-zero exit, a timeout (exit 124), or an OOM (137) all still HAVE an exit
 *  code, so they are yielded as `{kind:"exit", code}` events for the model to react to.
 *
 *  The rule is mechanical: exit code exists ⇒ yield it; no exit code ⇒ throw this. Never
 *  synthesize a fake exit code for an infrastructure failure — that lies to the model,
 *  telling it a command failed when it may have succeeded.
 *
 *  Two subclasses split unavailability by what a retry can do about it. Throw the base
 *  class only when neither applies — evidence is genuinely ambiguous. The caller's policy
 *  keys on the subclass, so a driver must never claim `gone` without positive evidence
 *  (the provider answered and said the sandbox does not exist): misclassifying a network
 *  blip as `gone` turns a retryable hiccup into a terminal failure. */
export class SandboxUnavailableError extends Error {
  readonly kind: "sandbox_unavailable" | "sandbox_unreachable" | "sandbox_gone" =
    "sandbox_unavailable";
}

/** The sandbox most likely still exists but THIS attempt could not reach it (transport
 *  failure, provider API error). Retrying against the same handle can succeed — the
 *  idemKey protocol makes that retry safe. */
export class SandboxUnreachableError extends SandboxUnavailableError {
  override readonly kind = "sandbox_unreachable";
}

/** The provider positively reported the sandbox does not exist (destroyed, expired past
 *  recovery). Its filesystem is lost; no retry against this handle can ever succeed. */
export class SandboxGoneError extends SandboxUnavailableError {
  override readonly kind = "sandbox_gone";
}
