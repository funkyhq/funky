// packages/ports/harness/src/claude-code.test.ts — the driver against a FAKE SDK.
//
// Everything here is offline: `queryFn` is the test seam standing where the Agent
// SDK's query() would spawn the Claude Code subprocess. Two surfaces are under test:
//   1. makeExecToolHandler — the exec bridge's write-ahead discipline (journal →
//      idemKey from the landed seq → exec → record) and its failure propagation.
//   2. ClaudeCodeHarness.runTurn — message projection, mirror_error policy, result
//      mapping, and option plumbing (resume, model, confinement).
// The real-SDK path is exercised end-to-end only with an API key (not in this suite).

import { describe, expect, it } from "vitest";
import type { Db } from "@funky/db";
import {
  ClaudeCodeHarness,
  makeExecToolHandler,
} from "./drivers/claude-code";
import {
  HarnessPermanentError,
  HarnessTransientError,
  type HarnessProjectedEvent,
  type HarnessTurnRequest,
} from "./port";

// ------------------------------------------------------------------ exec bridge

function bridgeCtx() {
  const calls: string[] = [];
  const appended: HarnessProjectedEvent[] = [];
  const failures: unknown[] = [];
  let seq = 10;
  const ctx = {
    sessionId: "11111111-1111-1111-1111-111111111111",
    append: async (e: HarnessProjectedEvent) => {
      calls.push(`append:${e.kind}`);
      appended.push(e);
      return { seq: ++seq };
    },
    exec: async (_call: unknown, idemKey: string) => {
      calls.push(`exec:${idemKey}`);
      return { output: "hi\n", exitCode: 0, truncated: false };
    },
    fail: (err: unknown) => failures.push(err),
  };
  return { ctx, calls, appended, failures };
}

describe("makeExecToolHandler — the exec bridge", () => {
  it("journals BEFORE executing, derives the idemKey from the landed seq, records the result", async () => {
    const { ctx, calls, appended } = bridgeCtx();
    const handler = makeExecToolHandler(ctx);

    const result = await handler({ cmd: "echo hi" });
    // Write-ahead order: the log sees the decision before the sandbox does.
    expect(calls).toEqual([
      "append:assistant_message",
      `exec:${ctx.sessionId}:11:0`, // idemKey = the seq the journal landed at
      "append:tool_result",
    ]);
    const journal = appended[0] as Extract<HarnessProjectedEvent, { kind: "assistant_message" }>;
    expect(journal.toolCalls).toEqual([{ kind: "exec", cmd: "echo hi" }]);
    const recorded = appended[1] as Extract<HarnessProjectedEvent, { kind: "tool_result" }>;
    expect(recorded.idemKey).toBe(`${ctx.sessionId}:11:0`);
    expect(result.content[0]).toEqual({ type: "text", text: "hi\n" });
  });

  it("a non-zero exit is a RESULT the model sees, flagged isError, never thrown", async () => {
    const { ctx } = bridgeCtx();
    ctx.exec = async () => ({ output: "boom\n", exitCode: 3, truncated: false });
    const result = await makeExecToolHandler(ctx)({ cmd: "exit 3" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "boom\n\n[exit code: 3]" });
  });

  it("an append rejection (conflict/fence) reaches fail() and rethrows — no exec happens", async () => {
    const { ctx, calls, failures } = bridgeCtx();
    const conflict = new Error("seq taken");
    ctx.append = async () => {
      calls.push("append:rejected");
      throw conflict;
    };
    await expect(makeExecToolHandler(ctx)({ cmd: "echo hi" })).rejects.toThrow("seq taken");
    expect(failures).toEqual([conflict]); // the driver aborts the subprocess on this
    expect(calls).toEqual(["append:rejected"]); // the sandbox never saw the command
  });

  it("timeout_ms travels on the journaled call", async () => {
    const { ctx, appended } = bridgeCtx();
    await makeExecToolHandler(ctx)({ cmd: "sleep 1", timeout_ms: 5000 });
    const journal = appended[0] as Extract<HarnessProjectedEvent, { kind: "assistant_message" }>;
    expect(journal.toolCalls).toEqual([{ kind: "exec", cmd: "sleep 1", timeout_ms: 5000 }]);
  });
});

// ------------------------------------------------------------------ runTurn vs fake SDK

/** Minimal fake SDK message stream. The driver only reads type/subtype + a few fields. */
function fakeQuery(messages: Array<Record<string, unknown>>) {
  const seen: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const queryFn = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    seen.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as never;
  return { queryFn, seen };
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "cc-abc",
  usage: { input_tokens: 7, output_tokens: 9 },
};

function makeRequest(overrides: Partial<HarnessTurnRequest> = {}): {
  req: HarnessTurnRequest;
  appended: HarnessProjectedEvent[];
} {
  const appended: HarnessProjectedEvent[] = [];
  let seq = 1;
  const req: HarnessTurnRequest = {
    namespace: "test-ns",
    sessionId: "22222222-2222-2222-2222-222222222222",
    attempt: "attempt-1",
    systemPrompt: "be helpful",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    prompt: "do the thing",
    resume: null,
    limits: { maxTurns: 20 },
    exec: async () => ({ output: "", exitCode: 0, truncated: false }),
    append: async (e) => {
      appended.push(e);
      return { seq: ++seq };
    },
    ...overrides,
  };
  return { req, appended };
}

function harness(queryFn: never) {
  // The store is only constructed, never queried, when queryFn is fake — a dummy Db
  // is safe here.
  return new ClaudeCodeHarness({ db: {} as Db, apiKey: "sk-test", queryFn });
}

describe("ClaudeCodeHarness.runTurn — projection and result mapping", () => {
  it("projects top-level assistant text, maps a success result, and plumbs the options", async () => {
    const { queryFn, seen } = fakeQuery([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "working on it" }] },
      },
      {
        // Subagent output must NOT be projected.
        type: "assistant",
        parent_tool_use_id: "toolu_123",
        message: { content: [{ type: "text", text: "subagent noise" }] },
      },
      successResult,
    ]);
    const { req, appended } = makeRequest({ resume: "cc-prev" });

    const result = await harness(queryFn).runTurn(req);
    expect(result).toEqual({
      sdkSessionId: "cc-abc",
      usage: { inputTokens: 7, outputTokens: 9 },
      stop: { type: "success" },
    });

    expect(appended).toEqual([
      {
        kind: "assistant_message",
        content: [{ type: "text", text: "working on it" }],
        toolCalls: [],
      },
    ]);

    const { prompt, options } = seen[0]!;
    expect(prompt).toBe("do the thing");
    expect(options["resume"]).toBe("cc-prev");
    expect(options["model"]).toBe("claude-sonnet-5");
    expect(options["systemPrompt"]).toBe("be helpful");
    expect(options["maxTurns"]).toBe(20);
    // Confinement: no built-in tools, no host settings, only the exec bridge.
    expect(options["tools"]).toEqual([]);
    expect(options["allowedTools"]).toEqual(["mcp__funky__exec"]);
    expect(options["settingSources"]).toEqual([]);
    expect(options["permissionMode"]).toBe("dontAsk");
    // Statelessness plumbing: fenced store + eager flush + scratch config dir.
    expect(options["sessionStore"]).toBeDefined();
    expect(options["sessionStoreFlush"]).toBe("eager");
    const env = options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toContain("attempt-");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
  });

  it("drains in-flight projected appends before returning — a slow appender never loses the final message", async () => {
    const { queryFn } = fakeQuery([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "final answer" }] },
      },
      successResult, // arrives immediately after the text — the race window
    ]);
    // A DB-realistic appender: resolves on a macrotask, so it is still in flight
    // when the result message is processed. Without the drain, runTurn resolves
    // before the append lands and the caller's commit races it for the next seq.
    const appended: HarnessProjectedEvent[] = [];
    const { req } = makeRequest({
      append: async (e) => {
        await new Promise((r) => setTimeout(r, 10));
        appended.push(e);
        return { seq: appended.length };
      },
    });

    await harness(queryFn).runTurn(req);
    expect(appended).toEqual([
      {
        kind: "assistant_message",
        content: [{ type: "text", text: "final answer" }],
        toolCalls: [],
      },
    ]);
  });

  it("a slow append that REJECTS still fails the turn — the error is not lost after return", async () => {
    const { queryFn } = fakeQuery([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "final answer" }] },
      },
      successResult,
    ]);
    const { req } = makeRequest({
      append: async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("seq taken");
      },
    });
    await expect(harness(queryFn).runTurn(req)).rejects.toThrow("seq taken");
  });

  it("maps error_max_turns to a budget stop (still carrying the transcript tip)", async () => {
    const { queryFn } = fakeQuery([
      { ...successResult, subtype: "error_max_turns" },
    ]);
    const { req } = makeRequest();
    const result = await harness(queryFn).runTurn(req);
    expect(result.stop).toEqual({ type: "budget", message: "harness max_turns exhausted" });
    expect(result.sdkSessionId).toBe("cc-abc");
  });

  it("error_during_execution → HarnessTransientError (the queue's backoff owns the retry)", async () => {
    const { queryFn } = fakeQuery([
      { ...successResult, subtype: "error_during_execution", errors: ["api blew up"] },
    ]);
    const { req } = makeRequest();
    await expect(harness(queryFn).runTurn(req)).rejects.toThrowError(HarnessTransientError);
  });

  it("a stream that ends without a result message is transient", async () => {
    const { queryFn } = fakeQuery([]);
    const { req } = makeRequest();
    await expect(harness(queryFn).runTurn(req)).rejects.toThrowError(HarnessTransientError);
  });

  it("mirror_error without a fence loss aborts the turn as transient — a committed turn never sits on a holed transcript", async () => {
    const { queryFn } = fakeQuery([
      {
        type: "system",
        subtype: "mirror_error",
        error: "db unreachable",
        key: { projectKey: "pk", sessionId: "cc-abc" },
      },
      successResult, // even a later success must NOT win over the dropped batch
    ]);
    const { req } = makeRequest();
    await expect(harness(queryFn).runTurn(req)).rejects.toThrowError(HarnessTransientError);
  });

  it("a non-anthropic model is a permanent config error", async () => {
    const { queryFn } = fakeQuery([successResult]);
    const { req } = makeRequest({ model: { provider: "openai", model: "gpt-x" } });
    await expect(harness(queryFn).runTurn(req)).rejects.toThrowError(HarnessPermanentError);
  });
});
