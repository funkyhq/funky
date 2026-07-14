# tests/chaos — the durability warranty

This suite turns Funky's central claim from a design document into a property CI re-proves on
every commit:

> **A worker can die at any moment. The turn still completes, exactly once.**

Everything runs offline and deterministic: [testcontainers](https://testcontainers.com)
Postgres + the `subprocess` sandbox + a scripted, log-aware `FakeLlm`. No API keys, no
network.

## The four invariants under test

| # | invariant | enforced by |
|---|-----------|-------------|
| **I1** | the final event log is identical whether or not workers crashed | the log is the only state; the reducer is a pure fold over it |
| **I2** | no event is ever written twice | PK `(session_id, seq)` → SQLSTATE 23505 → `ErrConflict` |
| **I3** | no command is ever *executed* twice | idemKey derived from log position + the sandbox's `mkdir`-dedupe |
| **I4** | every turn ends in a terminal event — a session never hangs | the last-attempt escalation in the turn's error policy |

The single most important assertion is I3: every scripted tool call appends one line to a
per-run **marker** file. After any scenario, the marker must have exactly one line per call —
two lines means the command ran twice and the core promise is a lie.

## The scenarios

| file | scenario |
|------|----------|
| `reference.test.ts` | the no-chaos baseline that pins `REFERENCE_LOG` |
| `h1.kill-boundaries.test.ts` | ★ kill worker A at **every** append boundary; B finishes → the log always matches |
| `h2.double-delivery.test.ts` | one job handed to two workers → one winner, one clean `ErrConflict` loser |
| `h3.slow-vs-lease.test.ts` | a slow-but-alive worker vs. a fresh reclaimer racing the same session |
| `h4.reattach.test.ts` | ★ B **re-attaches** to A's still-running command — the marker proves it wasn't re-run |
| `h5.terminal-event.test.ts` | a permanently broken sandbox → `turn_failed(SANDBOX_FATAL)`, never a hang |
| `h6.provision-crash.test.ts` | crash mid-provision → a second worker provisions; one event, one workdir |
| `h7.soak.test.ts` | 50 sessions × 3 workers × seeded random kills → all complete, zero double-execution |

## The one production seam

Crashing a worker at a precise log position needs a test-only hook, not mangled internals:
`EventStore`'s optional `onAfterAppend` (see `packages/sessions/src/store.ts`). It is
`undefined` in production — zero branches on the hot path. That is the **only** production
change this suite required.

## Running

```bash
pnpm -F chaos-tests test        # needs Docker (testcontainers)
pnpm -F chaos-tests typecheck
```

CI runs it as the dedicated, required-on-`main` `chaos` job (see `.github/workflows/ci.yml`).

## What this does NOT cover (yet)

Postgres dying mid-transaction (we trust ACID), network partitions (toxiproxy, later), and —
crucially — **sandbox isolation**. The `subprocess` driver has none: its commands run on the
host, so a command survives an in-process worker "crash" but not a real container death. When
the persistent provider driver (E2B via ComputeSDK) lands, swap it into `buildWorld` and this
same suite becomes its acceptance test.
