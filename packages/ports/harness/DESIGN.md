# The Harness Port — running managed agent SDKs on Funky's stateless runtime

Status: **implemented** (v1). First driver: **Claude Code**
(`@anthropic-ai/claude-agent-sdk`). See §11 for the map from this document to the code
and the tests that pin each guarantee.

This document explains what the harness port is, how the Claude Code driver keeps
Funky's core promise — **stateless, crash-resumable turn execution with exactly-once
command execution** — while the agentic loop runs inside a closed binary, and which
alternatives were considered and rejected.

---

## 1. What problem this solves

Funky's native loop (`packages/sessions/src/native-strategy.ts`) owns every step of a turn: it
calls the LLM port for one completion, records the tool call in the event log, runs it
in the sandbox, appends the result, repeats. The **log is the state**; any worker can
replay it and compute the next action (`reducer.ts`).

Agent SDKs like Claude Code invert this: the loop (context management, tool planning,
compaction, subagents) lives inside a vendor harness — for Claude Code, a
non-open-source CLI binary that the SDK spawns as a subprocess. We want Funky sessions
to be able to *be* a Claude Code conversation, without giving up:

1. **Stateless workers** — any worker can pick up any turn; nothing meaningful lives
   only in worker memory or on a worker's disk.
2. **Crash-resume as the normal code path** — a killed worker mid-turn loses nothing.
3. **Exactly-once command execution** — a command with side effects never runs twice
   because of a retry.
4. **The Funky sandbox** — commands execute in the session's provisioned sandbox
   (docker/e2b), never on the worker host.
5. **One durable record** — the Postgres event log stays the API/SSE source of truth.

## 2. The two SDK features that make this possible

Both are documented SDK behavior (code.claude.com/docs/en/agent-sdk/session-storage):

- **`SessionStore` adapter** (`options.sessionStore`): the SDK mirrors every transcript
  entry (JSONL line) to a caller-provided store. `append(key, entries)` is called in
  batches **continuously during the turn** (~100ms cadence while active); `load(key)`
  is called before subprocess spawn when `resume` is set. Funky provides a Postgres
  adapter, so **the Funky DB is the session storage** for Claude Code.

- **Ephemeral local disk**: the binary always writes its JSONL locally first; the store
  is a mirror. Pointing `CLAUDE_CONFIG_DIR` at a RAM-backed scratch directory (created
  per attempt, deleted after) makes the local copy disposable. The docs endorse exactly
  this ("set CLAUDE_CONFIG_DIR=/tmp for ephemeral local copy").

So the durable trajectory lives in Postgres; the local filesystem is a per-attempt
cache. Any worker can run the next turn: `load()` rehydrates the transcript from the
DB, the subprocess resumes it.

Two documented caveats we design around:

- `sessionStore` cannot be combined with `persistSession: false` or file checkpointing.
- **Mirror writes are best-effort**: after 3 failed attempts a batch is *dropped* and a
  `{type:"system", subtype:"mirror_error"}` message is emitted. Because our local copy
  is ephemeral, a dropped batch would be silent context loss — so the driver treats
  `mirror_error` as a turn-aborting transient failure (§6). A committed turn is
  therefore always backed by a gap-free mirrored transcript.

## 3. Architecture

```
                       ┌────────────────────────────────────────────────┐
                       │ worker (apps/worker)                           │
                       │                                                │
 turn job ──────────▶  │  runTurn ──┬─ nativeStrategy                   │
                       │  (shell)   └─ harnessStrategy                  │
                       │                   │        ▲ projected events  │
                       │                   ▼        │ (conditional      │
                       │            HarnessPort     │  appends)         │
                       │                   │        │                   │
                       │      ┌────────────┴─────────────┐              │
                       │      │ ClaudeCodeHarness driver │              │
                       │      │  query() → CC subprocess │              │
                       │      │  CLAUDE_CONFIG_DIR=tmpfs │              │
                       │      └───┬───────────┬──────────┘              │
                       └──────────┼───────────┼─────────────────────────┘
                                  │           │
                    MCP exec bridge       SessionStore (fenced)
                                  │           │
                                  ▼           ▼
                        Funky sandbox     Postgres
                        (idemKey exec)    ├ session_events        (the log — truth)
                                          └ harness_transcript_entries (CC transcript)
```

Division of labor (mirrors the llm/sandbox ports):

- **`@funky/harness` — the port** (`src/port.ts`). Plain TypeScript interface. Knows
  nothing about the event log, the queue, or Postgres row shapes. Drivers are selected
  by config at the entrypoint; the worker never imports a driver.
- **`ClaudeCodeHarness` — the driver** (`src/drivers/claude-code.ts`). Owns the SDK
  invocation, the MCP exec bridge, the ephemeral config dir, and mirror-error watching.
  It reports events through a caller-provided appender and never touches the log
  directly.
- **`harnessStrategy` — the caller** (`packages/sessions/src/harness-strategy.ts`). Owns
  the harness-specific stateful work: fence acquisition, crash recovery, the commit
  transaction, and the harness error classes. This is one `TurnStrategy`
  (`packages/sessions/src/strategy.ts`); the native loop is another (`nativeStrategy`).
- **`runTurn` — the shell** (`packages/sessions/src/turn.ts`). Owns everything the two
  strategies share: the session gate, the pinned-version load, the single log read, the
  conditional-append helper (and therefore conflict semantics), `terminalFail`,
  exec-with-reboot, and the outcome/error mapping. It selects the strategy by the pinned
  `runtime` and dispatches. The native loop is the degenerate strategy — its context is
  a pure function of the log, so it needs no attempt-token fence, no recovery pre-pass,
  and no continuation prompt; those exist *only* to reconcile a harness's external
  transcript with the log.

### Selection

Agent behavior is versioned, so the switch lives on `agent_config_versions.runtime`
(jsonb): `null` / `{"type":"native"}` → the existing loop; `{"type":"claude-code"}` →
the harness. Sessions pin the agent version, so a session's runtime never changes
mid-life.

## 4. Exactly-once command execution

### 4.1 How the native loop does it (recap)

- The idemKey is **derived from log position** (`idemKeyFor(sessionId, seq, 0)`), and
  the assistant's tool call is appended to the log **before** execution.
- `Executor.exec(cmd, idemKey)` performs an atomic `mkdir .funky/<idemKey>` inside the
  sandbox. The winner spawns the command detached; it writes `out` and stamps `exit`
  from inside the sandbox. Any later call with the same key loses the `mkdir` and
  simply tails the same files. Exec-with-known-key *is* attach.
- The sandbox outlives workers. Recovery is **forward-only re-attach**, never rollback.

### 4.2 The harness transplant

The model's loop is closed, but every command still funnels through code we own: the
built-in execution tools (Bash/Read/Edit/…) are disabled, and the only execution
surface is an in-process **MCP tool `exec`** (`createSdkMcpServer`) whose handler:

1. **Appends first.** The tool call is projected as an `assistant_message` event via a
   conditional append; the seq it lands at yields the idemKey — the log is the
   write-ahead journal, exactly as in the native loop.
2. **Then executes** through the session's `Executor` (same port, same `mkdir` lock,
   same reboot-once policy).
3. **Then appends the `tool_result`** and returns the output to the model.

An `ErrConflict` on any append means another worker owns the turn: the driver aborts
the subprocess and stands down.

### 4.3 Crash recovery protocol

On (re)delivery of a harness turn, `harnessStrategy` (run by the `runTurn` shell):

1. Reads the log. Terminal tail → stale redelivery → ack (`noop`).
2. **Acquires the fence** (§5): appends `harness_attempt_started {attempt}` at
   `lastSeq+1` and sets `sessions.harness_attempt = attempt` in one transaction.
   Losing the seq race = another worker owns the turn.
3. **Resolves unanswered exec calls** from this turn (reducer step 4, harness
   flavor): for each projected `assistant_message` tool call without a matching
   `tool_result`, re-run `exec` with the *same* idemKey. If the crashed attempt
   started it, this attaches; if the crash landed between append and spawn, this
   starts it — the logged decision is replayed, and the `mkdir` lock makes the race
   against a zombie harmless. Append each `tool_result`.
4. Builds the prompt: a fresh turn sends the user's message; a resumed turn sends a
   continuation prompt carrying the recovered results ("the run was interrupted; the
   command you started completed with exit N and output …; continue").
5. Runs the driver with `resume: <transcript tip>` (§5.2).
6. **Commits**: `turn_completed` + committed harness state on the session row, one
   transaction.

Case analysis for a command with side effects:

| Crash point | What happens on retry |
|---|---|
| before the `assistant_message` append | nothing was decided durably and nothing ran; the model re-decides on continuation — zero executions so far |
| after append, before exec spawn | recovery replays the logged decision — runs once |
| after exec spawn, before `tool_result` | command kept running in the sandbox; recovery **attaches** — runs once |
| after `tool_result`, before commit | recovery sees it answered; continuation prompt reports it — runs once |

No path executes a command twice. A model that *chooses* to re-run something after
reading the recovery note is issuing a new command — the same as a user asking twice.

## 5. Write fencing (the zombie-worker problem)

### 5.1 The problem and the native precedent

A worker whose lease expired may still be alive (GC pause, partition) with a live
Claude subprocess still mirroring entries. The native loop solves the analogous
problem with the conditional append: `(session_id, seq)` is the PK, the loser's insert
violates it, `ErrConflict`, stand down. One linear history; the DB is the fence.

The `SessionStore` contract has no caller-computed seq — batches are opaque and
unconditional — so we fence in the adapter, which we own:

- Acquiring a turn attempt sets `sessions.harness_attempt = <token>` (transactionally
  with the `harness_attempt_started` event — winning the seq race *is* acquiring the
  fence).
- The adapter's `append` is a **single guarded INSERT**:
  `INSERT … WHERE (SELECT harness_attempt FROM sessions …) = $token` — the check is
  fused into the write (no separate read, no TOCTOU). Zero rows inserted → the adapter
  throws → the SDK surfaces `mirror_error` → the zombie driver aborts.

A zombie is therefore killed by whichever write it attempts first — a transcript batch
(fence) or a tool call (log conflict) — and until it dies, every one of its writes
bounces. Worker B flips the fence *before* `load()`, so B reads exactly A's accepted
prefix; nothing can interleave after the flip.

Severity asymmetry the driver must preserve: for a **fenced** writer, rejection means
"stand down" (ack as conflict); for the **current** attempt, a mirror failure that is
*not* a fence rejection (DB blip, retries exhausted) means "the transcript would have
a hole" → abort and retry later. The adapter throws distinguishable errors.

### 5.2 The transcript lineage

Because fenced writes never land, every row in `harness_transcript_entries` belongs to
a legitimate attempt — so **the table itself records the lineage**. The resume point is
simply the `sdk_session_id` of the max-`ord` main-transcript row for the Funky
session; the committed pointer on the session row is a cache/audit field, not the
authority. This is robust to either SDK behavior on resume (same session id, or a
newly minted one): whatever id the entries land under is the tip.

## 6. Failure taxonomy

Mapped onto the existing worker outcomes — no queue or worker changes:

| Condition | Class | Outcome |
|---|---|---|
| fence lost / seq conflict | conflict | ack silently (another worker owns it) |
| `mirror_error` on current attempt | `HarnessTransientError` | nack → `retry_later`; terminal `INTERNAL` on last attempt |
| SDK/process transient failure, `error_during_execution` result | `HarnessTransientError` | same |
| non-anthropic model, auth failure | `HarnessPermanentError` | `turn_failed(HARNESS)` |
| harness session on a worker with no driver (no `ANTHROPIC_API_KEY`) | — | terminal `turn_failed(HARNESS)` |
| `error_max_turns` / `error_max_budget_usd` result | budget stop (returned, not thrown) | `turn_failed(BUDGET)` — the transcript tip is still committed, so the session continues cleanly on the next turn |
| sandbox unobservable, reboot fails | `SandboxUnavailableError` | `retry_later` → `SANDBOX_FATAL` on last attempt (identical to native; a fatally dead sandbox fails the session honestly — see §7 "snapshots") |

## 7. Alternatives considered (and why not)

**Fork-per-turn / fork-per-attempt transcripts.** Earlier design: every attempt
`forkSession`s from the last committed Claude session id; commit advances the pointer;
crashed attempts leave orphaned branches. Correct, and attractive because retries
replay from a clean snapshot — but (a) retry-by-fork lets the model *re-decide* the
turn, degrading tool execution to at-least-once unless paired with the §4.3 recovery
anyway, and (b) fork copies the entire history per turn (O(n²) storage). Once write
fencing gives the same writer-isolation guarantee the fork was providing, the fork
buys nothing: dropped in favor of one linear transcript per session — structurally
identical to the native event log.

**Docker/CRIU snapshot-and-restore for failed steps.** Snapshot the sandbox (FS +
memory) after every step; on failure restore the last snapshot and re-run. Rejected
for two reasons. Practically: `docker checkpoint` (CRIU) is experimental and fragile,
and E2B exposes pause/resume, not point-in-time restore. Fundamentally: restore
*worsens* side-effect semantics — a command that fired an external effect (HTTP POST,
`git push`, email) before the crash would be re-run against a rolled-back sandbox that
no longer remembers it ran, duplicating the effect. Snapshots can roll back the
sandbox but not the world. Funky's model — the one execution survives (detached, in a
sandbox that outlives workers) and retries **attach** to it — is the only way to
exactly-once for side-effecting commands. Consequence kept from the native design: a
*fatally* destroyed sandbox is an honest `SANDBOX_FATAL` failure, never a silent
re-provision (a fresh sandbox would make the log lie about accumulated state).

**Adapter-level fencing vs. fork (the tie-breaker).** Fencing needs the attempt token
plumbed into the adapter and a guarded insert; fork needs neither but costs O(n²)
storage and leaves branch bookkeeping. With the guard fused into the INSERT (one
statement, no extra round trip, no TOCTOU) fencing is as simple and strictly closer to
the native design (single linear history, losers' writes physically rejected). Chosen.

**Sandbox-hosted harness (run the SDK inside the sandbox).** Would give Claude Code
its full native tool surface (Read/Edit/Grep operate on the sandbox FS directly).
Rejected for v1: the `ANTHROPIC_API_KEY` would live inside the sandbox — readable by
any code the agent writes — and the worker would have to manage a harness process
lifecycle through the sandbox boundary. The MCP exec bridge keeps the key on the
worker and reuses the TCK-verified exec protocol. The port shape does not preclude a
sandbox-hosted driver later.

**Reusing `session_events` as the SessionStore.** The transcript entry format is
CLI-internal, opaque, and much richer than our event schema (thinking blocks,
compaction state, summaries, tags). Storing entries as our typed events would couple
us to an undocumented format; projecting *both* directions invites divergence. Instead
entries are stored verbatim in their own table (pass-through blobs, per the SDK
contract) and the log receives a **projection** (assistant text, exec calls, results)
that the existing API/SSE/UI consume unchanged.

**Trusting the SDK transcript for exec idempotency (tool_use ids as idemKeys without
the log).** Mirror writes are best-effort and batched; a tool call can execute before
its transcript entry is durably mirrored. The Funky log append is synchronous and
conditional — that's what a write-ahead journal needs — so the log stays the journal
and the transcript stays a mirror.

## 8. Schema

```
harness_transcript_entries
  project_key        text      — SessionKey.projectKey (sanitized cwd; deterministic per session)
  sdk_session_id     text      — SessionKey.sessionId (the agent SDK's own session id; SDK-neutral)
  subpath            text ''   — '' = main transcript; 'subagents/agent-<id>' otherwise
  ord                bigserial — append order within a key (load ORDER BY)
  entry_uuid         text?     — dedupe key; retried batches may re-deliver entries
  entry              jsonb     — opaque SessionStoreEntry, persisted verbatim
  namespace          text      — tenancy scoping
  funky_session_id   uuid      — lineage-tip query + GC + the fence join
  created_at         timestamptz

  unique (sdk_session_id, subpath, entry_uuid) where entry_uuid is not null
  index  (project_key, sdk_session_id, subpath, ord)
  index  (funky_session_id)

sessions               + harness_attempt text?   — current fence token
                       + harness_state   jsonb?  — committed { driver, sdk_session_id } (cache/audit; tip query is authoritative)

agent_config_versions  + runtime jsonb?          — null/native | {"type":"claude-code"}
```

Event model additions (`packages/sessions/src/events.ts`):

- `harness_attempt_started { attempt, resumed_from }` — bookkeeping; skipped by
  `buildContext`. `attempt` is the fence token; `resumed_from` records the transcript
  tip this attempt resumed from (audit).
- `turn_failed.error_class` gains `"HARNESS"`.

Everything else projects onto existing event types (`assistant_message`,
`tool_result`, `turn_completed`, `turn_failed`); the SSE/API surface is unchanged. An
SDK assistant message with parallel exec calls is projected as one `assistant_message`
event per call, respecting the v1 `tool_calls.max(1)` runtime cap. Thinking blocks are
not projected in v1 (additive `ContentBlock` kind later).

## 9. Driver specifics (Claude Code)

- `query()` options: `resume` (transcript tip or fresh), `systemPrompt` and `model`
  from the pinned agent version, `maxTurns` from `tool_policy.max_iterations`,
  `mcpServers: { funky: <exec bridge> }`, built-in tools disabled (`tools: []`),
  `allowedTools: ["mcp__funky__exec"]`, `permissionMode: "dontAsk"`,
  `settingSources: []` (full isolation from host settings/CLAUDE.md),
  `env: { CLAUDE_CONFIG_DIR: <per-attempt scratch dir> }`, `abortController`
  (aborted on conflict/fence loss), `sessionStore` (the fenced adapter bound to this
  attempt's token) with `sessionStoreFlush: "eager"` (a crash loses at most the
  in-flight frame).
- `cwd` must be **deterministic per session** (default `<cwdRoot>/<funky-session-id>`)
  because the SDK derives `projectKey` from the sanitized cwd and `load()` looks up by
  it. `cwdRoot` must be identical across the worker fleet — it is worker config
  (`FUNKY_HARNESS_CWD_ROOT`), and changing it orphans in-flight transcripts
  (documented operational constraint).
- The scratch dir (`FUNKY_HARNESS_SCRATCH_ROOT`) should live on RAM-backed storage —
  docker-compose mounts a tmpfs at `/dev/shm/funky-harness` for it. It holds only the
  disposable per-attempt local JSONL copy.
- Selection is data, not config: the worker constructs the driver whenever
  `ANTHROPIC_API_KEY` is set (independent of `FUNKY_LLM`); the pinned agent version's
  `runtime` decides per session. The API enforces `runtime: {"type":"claude-code"}` ⇒
  anthropic model at the edge (`apps/api/src/routes/agents.ts`).
- Provider must be `anthropic`; anything else is a `HarnessPermanentError`.
- Concurrency note: each in-flight harness turn is a spawned Node subprocess. The
  default `FUNKY_WORKER_CONCURRENCY=50` is sized for the native loop; deployments
  running mostly harness sessions should size it down.

## 10. Invariants (the contract, in one place)

1. Every exec decision is in the log **before** the sandbox sees it; its idemKey is
   its log position.
2. A command executes at most once per idemKey, no matter how many workers retry
   (sandbox `mkdir` lock + detached runner + in-sandbox exit stamping).
3. At most one attempt per Funky session can write transcript entries (fence), and at
   most one worker can append events at a given seq (PK). Losers stand down.
4. A committed turn implies a gap-free transcript in Postgres (mirror errors abort).
5. Recovery is forward-only: attach/replay from durable records; never roll back,
   never silently re-provision.

## 11. Implementation map

Where each piece of this document lives, and the test that pins it:

| Piece (§) | Code | Pinned by |
|---|---|---|
| The port + error taxonomy (§3, §6) | `src/port.ts` | type-level; policy tested via harness-turn tests |
| Exec bridge: journal → idemKey → exec → record (§4.2) | `makeExecToolHandler` in `src/drivers/claude-code.ts` | `src/claude-code.test.ts` ("journals BEFORE executing…") |
| Driver: confinement, projection, mirror_error, result mapping (§6, §9) | `ClaudeCodeHarness` in `src/drivers/claude-code.ts` | `src/claude-code.test.ts` (fake `queryFn` seam) |
| Fenced transcript store (§5.1) | `src/drivers/claude-code-store.ts` | `src/claude-code-store.test.ts` ("★ the write fence") |
| Transcript lineage / resume tip (§5.2) | `latestTranscriptTip` in `packages/sessions/src/harness-strategy.ts` (and `latestClaudeSessionId` in the store module) | store test "latestClaudeSessionId"; harness-turn test "resumes from the transcript tip" |
| Fence acquisition + recovery + commit (§4.3, §5) | `harnessStrategy` in `packages/sessions/src/harness-strategy.ts` | `packages/sessions/src/harness-turn.test.ts` — the two ★ crash-resume tests are the exactly-once proof |
| Shared turn shell + strategy seam (§3) | `runTurn` / `selectStrategy` in `packages/sessions/src/turn.ts`; `TurnShell` / `TurnStrategy` in `packages/sessions/src/strategy.ts`; `nativeStrategy` in `native-strategy.ts` | driven through `runTurn` by `turn.test.ts` + `harness-turn.test.ts` |
| Shared exec/reboot policy (§4.1) | `packages/sessions/src/exec.ts` (extracted from `turn.ts`, used by both strategies) | native `turn.test.ts` + chaos suite (unchanged) |
| Schema (§8) | `packages/db/schema/harness.ts`, `sessions.ts`, `configs.ts`; migration `20260718201401_harness_port` | `packages/db/src/schema.test.ts` |
| Event model additions (§8) | `harness_attempt_started` + `HARNESS` error class in `packages/sessions/src/events.ts` | `events.test.ts` round-trip |
| API edge (`runtime` on agents) (§3, §9) | `apps/api/src/routes/agents.ts`, `packages/configs/{types,service}.ts` | `apps/api/test/agents.test.ts` |
| Worker wiring + env knobs (§9) | `apps/worker/src/{index,config,worker}.ts`; compose tmpfs in `docker-compose.yml` | `apps/worker/test/config.test.ts` |

Not covered offline: a live end-to-end run against the real Claude Code subprocess
(needs `ANTHROPIC_API_KEY`). The driver's SDK-facing behavior is exercised through the
`queryFn` test seam; the real subprocess's message cadence and resume-id behavior
should be smoke-tested once per SDK upgrade (`resume` id changes are tolerated by
design — the tip query accepts whatever id entries land under).
