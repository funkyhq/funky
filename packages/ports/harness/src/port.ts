// packages/ports/harness/src/port.ts — the harness port.
//
// A "harness" is a vendor agent SDK that owns the agentic loop (context management,
// tool planning, compaction) — e.g. Claude Code. Plain TypeScript interface, NOT
// proto/codegen: a same-process contract the worker imports directly. Drivers are
// selected by config at the entrypoint; the worker never imports a driver.
//
// The port is deliberately LOG-BLIND: the driver reports projected events through a
// caller-provided appender and executes commands through a caller-provided exec
// function. The caller (@funky/sessions harnessStrategy) owns the event log, the
// conditional-append conflict semantics, the write fence, and the commit — so the
// crash-safety story lives in exactly one place. See DESIGN.md.

import type { HarnessState, ModelConfig } from "@funky/db/schema";
import type { ContentBlock, ToolCall } from "@funky/sessions/events";

export type { HarnessState };

/** What one exec produced. Non-zero exit / timeout(124) / OOM(137) are RESULTS, not
 *  errors — same rule as the sandbox port. */
export type ExecResult = { output: string; exitCode: number; truncated: boolean };

/** Runs one tool call under an idemKey with the caller's full retry/reboot policy.
 *  Calling with an idemKey that already ran MUST NOT run the command twice — the
 *  caller wires this to the sandbox port's exec/attach protocol. */
export type HarnessExecFn = (call: ToolCall, idemKey: string) => Promise<ExecResult>;

/** Events the driver projects into the Funky log — the SUBSET of the harness's
 *  activity that the API/SSE surface renders. The full vendor transcript is mirrored
 *  separately (the driver's session store); the log stays the source of truth for
 *  what EXECUTED. */
export type HarnessProjectedEvent =
  | {
      kind: "assistant_message";
      content: ContentBlock[];
      /** v1 cap: 0 or 1 calls, matching the log's tool_calls.max(1). A vendor message
       *  with parallel calls is projected as one event per call. */
      toolCalls: ToolCall[];
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: "tool_result";
      idemKey: string;
      output: string;
      exitCode: number;
      truncated: boolean;
    };

/** Conditionally appends a projected event; resolves with the seq it landed at (the
 *  driver derives exec idemKeys from it). MUST serialize internally — the driver may
 *  call it from concurrent contexts (message stream + tool handler). A rejection is
 *  the caller's conflict signal: the driver must abort the harness subprocess and
 *  rethrow the rejection unchanged. */
export type HarnessAppender = (e: HarnessProjectedEvent) => Promise<{ seq: number }>;

export type HarnessTurnRequest = {
  namespace: string;
  /** The Funky session id (trace, cwd derivation, store scoping). */
  sessionId: string;
  /** The write-fence token for this attempt — already installed on the session row
   *  by the caller. The driver binds its transcript store to it. */
  attempt: string;
  /** From the PINNED agent version. */
  systemPrompt: string;
  model: ModelConfig;
  /** The prompt for this turn: the user's message, or the caller-built continuation
   *  prompt when resuming a crashed attempt (recovery is the CALLER's job — by the
   *  time the driver runs, every logged exec decision is already resolved). */
  prompt: string;
  /** Vendor session id to resume from (the transcript tip); null = first turn. */
  resume: string | null;
  limits: { maxTurns?: number };
  exec: HarnessExecFn;
  append: HarnessAppender;
};

export type HarnessTurnResult = {
  /** The agent SDK's own session id this turn's transcript ended under — committed by
   *  the caller transactionally with turn_completed. */
  sdkSessionId: string;
  usage: { inputTokens: number; outputTokens: number };
  /** "success" → turn_completed; "budget" → turn_failed(BUDGET). Transient/permanent
   *  failures are thrown, never returned. */
  stop: { type: "success" } | { type: "budget"; message: string };
};

export interface HarnessPort {
  runTurn(req: HarnessTurnRequest): Promise<HarnessTurnResult>;
}

/** Retryable: subprocess/API transient failure, or a dropped transcript-mirror batch
 *  (a committed turn must never sit on a holed transcript — abort and retry). The
 *  worker nacks; on the last attempt it becomes turn_failed(INTERNAL). */
export class HarnessTransientError extends Error {
  readonly kind = "harness_transient" as const;
}

/** Not retryable: unsupported config, auth failure. Becomes turn_failed(HARNESS). */
export class HarnessPermanentError extends Error {
  readonly kind = "harness_permanent" as const;
}

/** This attempt lost the write fence — another worker owns the turn. Stand down
 *  silently (the caller maps it to the "conflict" outcome, like ErrConflict). */
export class HarnessFencedError extends Error {
  readonly kind = "harness_fenced" as const;
}
