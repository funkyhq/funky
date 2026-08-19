// Find-or-create the session's one sandbox — the ensure-on-claim half
// of the ratified lifecycle. Identity lives in the Store
// (sessions.sandbox_id, set through the bindSandbox CAS), so every
// claimer converges on one workspace BEFORE any tool executes: two
// racers may both create, but exactly one registers; the loser kills
// its own duplicate and connects to the winner. A pick made from
// provider listings could not give this — racers see different lists,
// and a committed step's workspace could be silently abandoned for the
// duplicate. The {sessionId} metadata stamped at create is
// observability, not identity.
//
// A binding can die under us — a "kill" TTL fired, or a paused sandbox
// expired past recovery. Only the provider's definitive
// SandboxNotFoundError triggers replacement (any other connect failure
// propagates: treating an outage as gone would abandon a live
// workspace), and the replacement runs the same convergence story one
// level up: create, CAS expecting the dead id, loser kills its
// duplicate and joins whoever replaced it first.
//
// The composition root closes the driver's `bindTools` dep over this:
//   bindTools: (sessionId) =>
//     ensureSandbox(store, provider, sessionId, opts).then(createSandboxTools)

import type { SessionId } from "@funky/core";
import {
  type CreateSandboxOptions,
  type Sandbox,
  SandboxNotFoundError,
  type SandboxProvider,
} from "../ports/sandbox-provider";
import type { Store } from "../ports/store";

export async function ensureSandbox(
  store: Pick<Store, "getSession" | "bindSandbox">,
  provider: SandboxProvider,
  sessionId: SessionId,
  createOpts?: CreateSandboxOptions,
): Promise<Sandbox> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`ensureSandbox: unknown session ${sessionId}`);
  return acquire(session.sandboxId);

  async function acquire(bound: string | undefined): Promise<Sandbox> {
    if (bound !== undefined) {
      try {
        return await provider.connect(bound);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
        // Definitively gone — fall through and replace the binding.
      }
    }
    const created = await provider.create({
      ...createOpts,
      metadata: { ...createOpts?.metadata, sessionId },
    });
    const winner = await store.bindSandbox(sessionId, created.sandboxId, bound);
    if (winner === created.sandboxId) return created;

    // Lost the registration race: discard the duplicate and join the
    // winner — recursively, since the winner may itself be dead by now.
    // A failed kill leaves an orphan for the TTL backstop.
    await created.kill().catch(() => {});
    return acquire(winner);
  }
}
