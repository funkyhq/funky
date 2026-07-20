// packages/sessions/src/exec.ts — exec collection + the single-reboot policy.
//
// Extracted from turn.ts so the native loop and the harness loop (harness-turn.ts)
// share ONE implementation of "run a tool call in the sandbox": collect the stream,
// treat a missing exit event as unobservable (never a zero exit), and on an
// unobservable sandbox reboot ONCE and retry by the same idemKey — the idemKey
// protocol re-attaches to a still-running command or re-runs it safely, so nothing
// runs twice.

import { and, eq } from "drizzle-orm";
import type { Db } from "@funky/db";
import { sessions } from "@funky/db/schema";
import type { Executor, SandboxDriver, SandboxHandle } from "@funky/sandbox";
import { SandboxUnavailableError } from "@funky/sandbox";
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

/** Exec with a single reboot on an unobservable sandbox. The same idemKey re-attaches
 *  to a still-running command or re-runs it safely, so nothing runs twice. A second
 *  failure propagates to the caller's error policy. The rebooted handle is persisted
 *  so later workers reconnect to the same sandbox. */
export function makeExecWithReboot(opts: {
  db: Db;
  sandbox: SandboxDriver;
  ns: string;
  sessionId: string;
  handle: SandboxHandle | null;
}): (call: ToolCall, idemKey: string) => Promise<ExecResult> {
  let handle = opts.handle;
  return async (call, idemKey) => {
    if (!handle) throw new SandboxUnavailableError("session has no sandbox handle");
    try {
      return await runExec(opts.sandbox.connect(handle), call, idemKey);
    } catch (err) {
      if (!(err instanceof SandboxUnavailableError)) throw err;
      handle = await opts.sandbox.reboot(handle); // persistent FS survives the reboot
      await persistHandle(opts.db, opts.ns, opts.sessionId, handle);
      return await runExec(opts.sandbox.connect(handle), call, idemKey);
    }
  };
}

export async function persistHandle(
  db: Db,
  ns: string,
  sessionId: string,
  handle: SandboxHandle,
): Promise<void> {
  await db
    .update(sessions)
    .set({ sandboxHandle: handle, updatedAt: new Date() })
    .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
}
