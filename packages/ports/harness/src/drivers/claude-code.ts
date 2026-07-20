// packages/ports/harness/src/drivers/claude-code.ts — the Claude Code harness driver.
//
// One runTurn = one `query()` = one Claude Code subprocess driving the agentic loop.
// The driver's job is confinement: the ONLY execution surface the model gets is the
// in-process MCP `exec` tool, which journals to the Funky log (via the caller's
// appender — the append yields the seq, the seq yields the idemKey) and then runs the
// command through the caller's exec function (the sandbox port's exactly-once
// protocol). Built-in tools are disabled; the subprocess's local session files live
// on a per-attempt scratch dir (point it at RAM-backed storage) and are deleted after
// the turn; the durable transcript is the fenced Postgres mirror.
//
// Failure discipline (DESIGN.md §6): an appender rejection or a fence loss aborts the
// subprocess and stands down; a dropped mirror batch (mirror_error) aborts the turn
// so a committed turn never sits on a holed transcript; SDK/API failures map onto the
// transient/permanent taxonomy.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "@funky/db";
import { idemKeyFor, textContent, type ToolCall } from "@funky/sessions/events";
import {
  HarnessFencedError,
  HarnessPermanentError,
  HarnessTransientError,
  type HarnessPort,
  type HarnessTurnRequest,
  type HarnessTurnResult,
} from "../port";
import { DrizzleSessionStore } from "./claude-code-store";

export const EXEC_TOOL = "exec";
/** Fully-qualified name the SDK gives an MCP tool: mcp__<server>__<tool>. */
const MCP_SERVER = "funky";
const EXEC_TOOL_FQN = `mcp__${MCP_SERVER}__${EXEC_TOOL}`;

export type ClaudeCodeHarnessOptions = {
  db: Db;
  apiKey: string;
  /** Parent dir for per-attempt CLAUDE_CONFIG_DIR scratch dirs. Point at RAM-backed
   *  storage (tmpfs) in production; the contents are disposable by design. */
  scratchRoot?: string;
  /** Parent dir for per-session cwd dirs. The SDK derives the transcript store's
   *  projectKey from the sanitized cwd, so this MUST be identical across the worker
   *  fleet — changing it orphans in-flight session transcripts. */
  cwdRoot?: string;
  /** Test seam: replaces the SDK's query(). */
  queryFn?: typeof sdkQuery;
};

export class ClaudeCodeHarness implements HarnessPort {
  private readonly db: Db;
  private readonly apiKey: string;
  private readonly scratchRoot: string;
  private readonly cwdRoot: string;
  private readonly queryFn: typeof sdkQuery;

  constructor(opts: ClaudeCodeHarnessOptions) {
    this.db = opts.db;
    this.apiKey = opts.apiKey;
    this.scratchRoot = opts.scratchRoot ?? join(tmpdir(), "funky-harness");
    this.cwdRoot = opts.cwdRoot ?? "/tmp/funky-harness-cwd";
    this.queryFn = opts.queryFn ?? sdkQuery;
  }

  async runTurn(req: HarnessTurnRequest): Promise<HarnessTurnResult> {
    if (req.model.provider !== "anthropic") {
      throw new HarnessPermanentError(
        `claude-code harness requires an anthropic model (got ${req.model.provider})`,
      );
    }

    // Deterministic per session → stable projectKey for the transcript store.
    const cwd = join(this.cwdRoot, req.sessionId);
    await mkdir(cwd, { recursive: true });
    // Per-attempt, disposable. The subprocess's local JSONL lives (and dies) here.
    await mkdir(this.scratchRoot, { recursive: true });
    const configDir = await mkdtemp(join(this.scratchRoot, "attempt-"));

    const store = new DrizzleSessionStore({
      db: this.db,
      namespace: req.namespace,
      funkySessionId: req.sessionId,
      attempt: req.attempt,
    });

    // First fatal error wins; everything after is the abort unwinding.
    const abort = new AbortController();
    let fatal: unknown;
    const fail = (err: unknown): void => {
      fatal ??= err;
      abort.abort();
    };

    // The appender may be called from the tool handler and the message loop
    // concurrently; the port contract says the CALLER serializes, but a driver-side
    // chain costs nothing and makes the driver correct against a non-conforming
    // caller too.
    let appendChain: Promise<unknown> = Promise.resolve();
    const append = (e: Parameters<HarnessTurnRequest["append"]>[0]) => {
      const next = appendChain.then(() => req.append(e));
      appendChain = next.catch(() => {});
      return next;
    };

    const execTool = tool(
      EXEC_TOOL,
      "Run a shell command in this session's sandbox and return its combined " +
        "stdout/stderr and exit code. This is the only way to execute commands, " +
        "read or write files, or access the network — the sandbox filesystem " +
        "persists across commands and turns.",
      {
        cmd: z.string().min(1).describe("The shell command to run."),
        timeout_ms: z
          .number()
          .int()
          .min(1)
          .max(600_000)
          .optional()
          .describe("Optional wall-clock timeout in milliseconds."),
      },
      makeExecToolHandler({ sessionId: req.sessionId, exec: req.exec, append, fail }),
    );

    const options: Options = {
      cwd,
      abortController: abort,
      resume: req.resume ?? undefined,
      systemPrompt: req.systemPrompt,
      model: req.model.model,
      maxTurns: req.limits.maxTurns,
      // Confinement: no built-in tools, no host settings/CLAUDE.md, no prompts.
      tools: [],
      allowedTools: [EXEC_TOOL_FQN],
      permissionMode: "dontAsk",
      settingSources: [],
      mcpServers: {
        [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, tools: [execTool] }),
      },
      // Statelessness: durable transcript in Postgres (fenced, eager flush so a crash
      // loses at most the in-flight frame), disposable local copy on scratch.
      sessionStore: store,
      sessionStoreFlush: "eager",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: this.apiKey,
      },
    };

    let result:
      | { subtype: string; session_id: string; usage: { input_tokens: number; output_tokens: number }; errors?: string[] }
      | undefined;

    try {
      for await (const msg of this.queryFn({ prompt: req.prompt, options })) {
        this.observe(msg as SDKMessage, { store, append, fail });
        if (msg.type === "result") {
          result = msg as typeof result & { type: "result" };
        }
      }
    } catch (err) {
      // An abort we triggered unwinds as an error here; the stored cause is the
      // truth. An SDK error without a stored cause is a transient turn failure —
      // the log + recovery make a retry safe.
      if (fatal === undefined) fatal = classify(err);
    } finally {
      // Drain the projected appends before deciding the turn's fate: observe()'s
      // assistant-text appends are fire-and-forget, and returning while one is still
      // in flight would race the caller's commit for the next seq — losing that race
      // silently drops the final message or fails a successful turn as a conflict.
      // The chain never rejects; a failed append lands in `fatal` via fail() before
      // this await resumes.
      await appendChain;
      await rm(configDir, { recursive: true, force: true }).catch(() => {});
    }

    if (fatal !== undefined) throw fatal;
    if (!result) {
      throw new HarnessTransientError("claude-code subprocess ended without a result message");
    }

    const usage = {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    };
    switch (result.subtype) {
      case "success":
        return { sdkSessionId: result.session_id, usage, stop: { type: "success" } };
      case "error_max_turns":
        return {
          sdkSessionId: result.session_id,
          usage,
          stop: { type: "budget", message: "harness max_turns exhausted" },
        };
      case "error_max_budget_usd":
        return {
          sdkSessionId: result.session_id,
          usage,
          stop: { type: "budget", message: "harness max budget exhausted" },
        };
      default:
        throw new HarnessTransientError(
          `claude-code turn failed (${result.subtype}): ${(result.errors ?? []).join("; ")}`,
        );
    }
  }

  /** Side-channel observation of the message stream: project assistant text into the
   *  log, and turn a dropped mirror batch into a turn-aborting failure. */
  private observe(
    msg: SDKMessage,
    ctx: {
      store: DrizzleSessionStore;
      append: HarnessTurnRequest["append"];
      fail: (err: unknown) => void;
    },
  ): void {
    if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const text = (msg.message.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      if (text.length > 0) {
        void ctx
          .append({ kind: "assistant_message", content: textContent(text), toolCalls: [] })
          .catch(ctx.fail);
      }
      return;
    }
    if (msg.type === "system" && msg.subtype === "mirror_error") {
      // The batch was DROPPED after retries. Ephemeral local copy ⇒ this would be
      // silent context loss if the turn committed. Fence loss stands down; anything
      // else retries the turn from the last good state.
      ctx.fail(
        ctx.store.fenced
          ? new HarnessFencedError("transcript write fenced (mirror_error)")
          : new HarnessTransientError(`transcript mirror batch dropped: ${msg.error}`),
      );
    }
  }
}

/** The exec bridge — the ONLY execution surface the model gets, and the load-bearing
 *  piece of the exactly-once story. Exported for direct unit testing. */
export function makeExecToolHandler(ctx: {
  sessionId: string;
  exec: HarnessTurnRequest["exec"];
  append: HarnessTurnRequest["append"];
  fail: (err: unknown) => void;
}) {
  return async (args: { cmd: string; timeout_ms?: number }) => {
    try {
      const call: ToolCall =
        args.timeout_ms !== undefined
          ? { kind: "exec", cmd: args.cmd, timeout_ms: args.timeout_ms }
          : { kind: "exec", cmd: args.cmd };
      // Journal FIRST: the decision enters the log before the sandbox sees it, and
      // the seq it lands at is the idemKey — the native loop's write-ahead
      // discipline, verbatim.
      const { seq } = await ctx.append({
        kind: "assistant_message",
        content: [],
        toolCalls: [call],
      });
      const idemKey = idemKeyFor(ctx.sessionId, seq, 0);
      const res = await ctx.exec(call, idemKey);
      await ctx.append({ kind: "tool_result", idemKey, ...res });
      return {
        content: [
          {
            type: "text" as const,
            text:
              res.exitCode === 0 ? res.output : `${res.output}\n[exit code: ${res.exitCode}]`,
          },
        ],
        ...(res.exitCode !== 0 ? { isError: true } : {}),
      };
    } catch (err) {
      // Conflict, fence loss, sandbox death — abort the subprocess; the caller's
      // error policy takes it from here. Rethrow so the SDK stops waiting.
      ctx.fail(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}

/** SDK/transport failures outside our own fail() path. AbortError without a recorded
 *  cause means the SDK aborted internally — retryable. */
function classify(err: unknown): unknown {
  if (err instanceof HarnessTransientError || err instanceof HarnessPermanentError) return err;
  if (err instanceof HarnessFencedError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/api key|authentication|401|403/i.test(msg)) {
    return new HarnessPermanentError(`claude-code auth failure: ${msg}`);
  }
  return new HarnessTransientError(`claude-code failure: ${msg}`);
}
