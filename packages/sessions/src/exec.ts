// packages/sessions/src/exec.ts — exec collection + the single-retry policy.
//
// Extracted from turn.ts so the native loop and the harness loop (harness-strategy.ts)
// share ONE implementation of "run a tool call in the sandbox": collect the stream,
// treat a missing exit event as unobservable (never a zero exit), and on a TRANSIENT
// unavailability reconnect ONCE and retry by the same idemKey — the idemKey protocol
// re-attaches to a still-running command or re-runs it safely, so nothing runs twice.
// A GONE sandbox is not retried: no reconnect can reach it, and only the caller's
// policy (turn.ts) may decide what its loss means.

import type { Executor, SandboxDriver, SandboxHandle } from "@funky/sandbox";
import { SandboxGoneError, SandboxUnavailableError } from "@funky/sandbox";
import type { ToolCall } from "./events";

export type ExecResult = { output: string; exitCode: number; truncated: boolean };

/** Run one exec. Non-zero exit / timeout(124) / OOM(137) are RESULTS (they carry an
 *  exit code) and are returned, never thrown. Only an unobservable command throws. */
export async function runExec(
  executor: Executor,
  call: ToolCall,
  idemKey: string,
): Promise<ExecResult> {
  const req = {
    cmd: call.cmd,
    idemKey,
    ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
  };
  let output = "";
  let exitCode = 0;
  let truncated = false;
  let sawExit = false;
  for await (const ev of executor.exec(req)) {
    if (ev.kind === "exit") {
      exitCode = ev.code;
      truncated = ev.truncated;
      sawExit = true;
    } else {
      output += ev.data; // stdout / stderr both fold into combined output
    }
  }
  // A stream that ends without an exit event is unobservable, not a zero exit.
  if (!sawExit) throw new SandboxUnavailableError("exec stream ended without an exit event");
  return { output, exitCode, truncated };
}

/** Exec with a single reconnect-and-retry on a transient unavailability. connect() is
 *  cheap and re-resolves the sandbox fresh (resuming a paused one), and the same idemKey
 *  re-attaches to a still-running command or re-runs it safely, so nothing runs twice.
 *  A GONE sandbox propagates immediately — retrying cannot fix a permanent loss — and a
 *  second transient failure propagates to the caller's error policy (the queue's backoff
 *  owns further retries). */
export function makeExec(opts: {
  sandbox: SandboxDriver;
  handle: SandboxHandle | null;
}): (call: ToolCall, idemKey: string) => Promise<ExecResult> {
  return async (call, idemKey) => {
    const { sandbox, handle } = opts;
    if (!handle) throw new SandboxUnavailableError("session has no sandbox handle");
    try {
      return await runExec(sandbox.connect(handle), call, idemKey);
    } catch (err) {
      if (!(err instanceof SandboxUnavailableError) || err instanceof SandboxGoneError) {
        throw err;
      }
      return await runExec(sandbox.connect(handle), call, idemKey);
    }
  };
}
