// Pause the session's sandbox the moment its run ends — the other half
// of ensure-on-claim. A sandbox runs, and bills, until it is paused;
// left alone that is the create's TTL (FUNKY_SANDBOX_TIMEOUT_MS), but
// once a commit leaves the session idle nothing will execute in it
// until the next run's first tool batch, whose bind connects and so
// revives it in place. The workspace filesystem survives either way.
//
// The driver calls this through StepDeps.pauseSandbox when commitStep
// answers idle, without waiting on it. The TTL stays as the backstop
// for a pause that never happens: a worker dying between the commit and
// the call, or the provider failing it.
//
// The one race: a new run could start before the pause lands — an
// intake right after the end — and bind the sandbox. Its bind comes
// only after a claim and a full inference step, so the pause has long
// been issued. Should it land on a running command anyway, the
// adapter's run() reconnects (reviving the sandbox) and retries the
// command once — so that command may run twice.
//
// The composition root closes the driver's `pauseSandbox` dep over this:
//   pauseSandbox: (ref) => pauseSessionSandbox(store, provider, ref)

import type { SessionRef } from "@funky/core";
import { SandboxNotFoundError, type SandboxProvider } from "../ports/sandbox-provider";
import type { Store } from "../ports/store";

/** Pause the sandbox bound to the session, if it has one — an
 *  inference-only session never bound any. One already paused, or gone,
 *  needs nothing. */
export async function pauseSessionSandbox(
  store: Pick<Store, "getSession">,
  provider: Pick<SandboxProvider, "pause">,
  ref: SessionRef,
): Promise<void> {
  const session = await store.getSession(ref);
  if (session?.sandboxId === undefined) return;
  try {
    await provider.pause(session.sandboxId);
  } catch (error) {
    // Gone: the next bind replaces the binding (ensure-sandbox.ts).
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
}
