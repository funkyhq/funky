# driver/

The claim → step → commit loop — the impure half of the harness, and
the Store port's second caller (`intake` is the api's write path;
`commitStep` is ours). Two exports, mechanism and policy:

- **`runStep(deps, claim, leaseMs)`** — one claim → at most one commit.
  The tested unit: the driver integration suite (in
  `packages/adapters`) drives it step by step against the real pg store.
- **`runDriver(deps, opts)`** — the production shell `apps/worker`
  hosts: claim, step, repeat, sleep on miss, until the process dies or
  the host's drain signal fires. Funky is cloud-only (2026-08-09):
  scale-down is the platform removing the container, and the crash rule
  makes that safe; the drain (2026-09-14) makes it cheap. The shell is
  covered at the process level by the crash-resume suite, and its drain
  in-process by the driver suite.

What lives here is what neither the engine nor a host may own:

- **Leases.** The heartbeat keeper extends the claim every `leaseMs / 3`;
  a lost — or merely unreachable — lease aborts the step. Like the drain
  deadline below, it bounds a zombie's side effects and spend, never
  correctness.
- **The crash rule.** An interrupted step is never committed. A dying
  worker commits nothing mid-step; the lease expires and the next
  claimer resumes from the unchanged log — re-running an inference
  item, but never an execute_tools item: `attempt > 1` marks the dead
  claimer, and the re-claim commits interrupted results instead of
  re-executing side effects (tools are at-most-once across claims).
  `FencedError` on commit is the same rule from the other side — the
  item's fate belongs to another claim; drop the work, claim again.
- **Drain.** SIGTERM precedes SIGKILL by a fixed few seconds on every
  planned removal (a scale-down, a deploy), and the platform picks the
  instance, busy or not. Once the drain signal fires the loop claims
  nothing more; a held claim gets `drainMs` to commit, and past that it
  is aborted and its lease released (`Store.releaseItem`), so another
  worker resumes the session on its next poll rather than after the
  lease. Nothing new to reason about: a released item is a dead
  claimer's item to the re-claim, and a drain cut short by SIGKILL is
  the crash path — which is thereby exercised on every unplanned death
  and on every drain that runs out of time.
- **Boundary cancel checks.** `cancelRequested` reads the log's tail:
  while an item is open, only cancels (and decoration entries) can
  trail the last message entry — a theorem of the one-open-item
  invariant — so a trailing cancel addresses the current run and
  anything behind the last message entry is already answered. Checked
  at the claim boundary (skip the step) and the commit boundary (end
  the run whatever the step produced). Valid only while holding the
  open item; a consumer with no claim needs the run-liveness derivation
  this deliberately isn't.
- **v1 policies, explicit and small.** Provider errors commit and end
  the run as `"error"` (no retry yet); idle claiming polls
  (`idlePollMs`) until a Notifier port exists.

The engine decides, the store persists, the driver survives.
