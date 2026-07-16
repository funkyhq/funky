// packages/sessions/src/provision.ts — Phase D: sandbox provisioning.
//
// Provision jobs (kind: "provision") ride the same queue and run on the same worker as
// turns. The snapshot of the env config into `resolved_env` happens HERE and is never
// re-read from the (mutable) env config: a sandbox reboot three days later must rebuild
// the SAME environment the session started with, not whatever the config says today. The
// snapshot makes reboots deterministic.

import { and, eq } from "drizzle-orm";
import type { Db } from "@funky/db";
import { envConfigs, type ResolvedEnv, sessions } from "@funky/db/schema";
import { makeEvent } from "./events";
import type { Job } from "./queue";
import { ErrConflict } from "./store";
import type { TurnDeps, TurnOutcome } from "./turn";

export async function runProvision(job: Job, deps: TurnDeps): Promise<TurnOutcome> {
  const ns = job.namespace;
  const sessionId = job.sessionId;

  const [session] = await deps.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)))
    .limit(1);
  if (!session) return "abandoned"; // no such session — nothing to provision
  if (session.status !== "provisioning") return "completed"; // already provisioned; stale job

  const [env] = await deps.db
    .select()
    .from(envConfigs)
    .where(and(eq(envConfigs.namespace, ns), eq(envConfigs.id, session.envConfigId)))
    .limit(1);
  if (!env) return failProvision(deps, job, ns, sessionId, "env config not found");

  // Snapshot the env config. template_id stays undefined for the subprocess driver.
  const resolvedEnv: ResolvedEnv = {
    egress: env.egress,
  };

  try {
    const handle = await deps.sandbox.provision(resolvedEnv, sessionId);
    // ONE transaction: flip the session to ready with its snapshot + handle, AND append
    // session_provisioned. Either both land or neither does.
    await deps.db.transaction(async (tx) => {
      const lastSeq = await deps.store.lastSeq(ns, sessionId, tx);
      await tx
        .update(sessions)
        .set({ resolvedEnv, sandboxHandle: handle, status: "ready", updatedAt: new Date() })
        .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
      const evt = makeEvent(
        { sessionId, namespace: ns, seq: lastSeq + 1 },
        "session_provisioned",
        {},
      );
      await deps.store.appendEvent(ns, sessionId, lastSeq + 1, evt, tx);
    });
    return "completed";
  } catch (err) {
    if (err instanceof ErrConflict) return "conflict"; // another worker already provisioned
    return failProvision(deps, job, ns, sessionId, err instanceof Error ? err.message : String(err));
  }
}

// A provisioning failure retries with backoff until the last attempt, then terminates the
// session — status 'failed' + turn_failed(SANDBOX_FATAL) in one transaction — so a session
// whose sandbox can never come up ends with a terminal event instead of hanging forever.
async function failProvision(
  deps: TurnDeps,
  job: Job,
  ns: string,
  sessionId: string,
  message: string,
): Promise<TurnOutcome> {
  if (job.attempts < job.maxAttempts) return "retry_later";
  try {
    await deps.db.transaction(async (tx) => {
      const lastSeq = await deps.store.lastSeq(ns, sessionId, tx);
      await tx
        .update(sessions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
      const evt = makeEvent({ sessionId, namespace: ns, seq: lastSeq + 1 }, "turn_failed", {
        error_class: "SANDBOX_FATAL",
        message,
      });
      await deps.store.appendEvent(ns, sessionId, lastSeq + 1, evt, tx);
    });
  } catch (e) {
    if (e instanceof ErrConflict) return "conflict";
    return "retry_later";
  }
  return "failed";
}
