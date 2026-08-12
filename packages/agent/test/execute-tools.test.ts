import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolCall } from "@funky/core";
import { executeTools, type ExecuteToolsDeps, type ToolUpdate } from "../src/engine/execute-tools";
import type { Tool, ToolOutcome } from "../src/engine/tool";

const liveSignal = (): AbortSignal => new AbortController().signal;

const call = (id: string, name: string, args: Record<string, string> = {}): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

/** Echoes its message back; records execution order; forwards chunks. */
const echoTool = (log?: string[]): Tool => ({
  name: "echo",
  description: "echoes",
  input: z.object({ message: z.string() }),
  async execute(args, ctx) {
    const { message } = args as { message: string };
    log?.push(`echo:${message}`);
    ctx.onChunk?.(message);
    return {
      content: [{ type: "text", text: message }],
      details: { echoed: message },
    } satisfies ToolOutcome;
  },
});

const throwingTool: Tool = {
  name: "bomb",
  description: "always throws",
  input: z.object({}),
  async execute() {
    throw new Error("kaboom");
  },
};

/** Parks until the signal fires, then raises like an interrupted subprocess. */
const slowTool: Tool = {
  name: "slow",
  description: "waits for abort",
  input: z.object({}),
  async execute(_args, ctx) {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("killed");
  },
};

const depsWith = (tools: Tool[], onUpdate?: (u: ToolUpdate) => void): ExecuteToolsDeps => ({
  tools: new Map(tools.map((t) => [t.name, t])),
  onUpdate,
});

describe("executeTools", () => {
  it("returns one successful result per call, in call order", async () => {
    const results = await executeTools(
      depsWith([echoTool()]),
      { calls: [call("c1", "echo", { message: "one" }), call("c2", "echo", { message: "two" })] },
      liveSignal(),
    );
    expect(results).toEqual([
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "echo",
        content: [{ type: "text", text: "one" }],
        details: { echoed: "one" },
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "echo",
        content: [{ type: "text", text: "two" }],
        details: { echoed: "two" },
        isError: false,
      },
    ]);
  });

  it("turns an unknown tool into an error result", async () => {
    const [result] = await executeTools(
      depsWith([]),
      { calls: [call("c1", "missing")] },
      liveSignal(),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([{ type: "text", text: "tool not found: missing" }]);
  });

  it("turns invalid arguments into an error result without executing", async () => {
    const log: string[] = [];
    const [result] = await executeTools(
      depsWith([echoTool(log)]),
      { calls: [call("c1", "echo", {})] }, // missing required `message`
      liveSignal(),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({
      text: expect.stringContaining("invalid arguments"),
    });
    expect(log).toEqual([]);
  });

  it("isolates a schema whose refinement throws, without failing the batch", async () => {
    // safeParse only swallows validation failures; an exception raised inside
    // a transform/refine body propagates, and must not sink the whole batch.
    const badSchemaTool: Tool = {
      name: "bad-schema",
      description: "schema throws while parsing",
      input: z.object({}).refine(() => {
        throw new Error("schema exploded");
      }),
      async execute() {
        return { content: [{ type: "text", text: "unreachable" }] } satisfies ToolOutcome;
      },
    };
    const results = await executeTools(
      depsWith([badSchemaTool, echoTool()]),
      { calls: [call("c1", "bad-schema"), call("c2", "echo", { message: "still here" })] },
      liveSignal(),
    );
    expect(results.map((r) => r.isError)).toEqual([true, false]);
    expect(results[0]?.content).toEqual([{ type: "text", text: "schema exploded" }]);
    expect(results[1]?.content).toEqual([{ type: "text", text: "still here" }]);
  });

  it("isolates a throwing tool and keeps executing the rest of the batch", async () => {
    const results = await executeTools(
      depsWith([throwingTool, echoTool()]),
      { calls: [call("c1", "bomb"), call("c2", "echo", { message: "still here" })] },
      liveSignal(),
    );
    expect(results.map((r) => r.isError)).toEqual([true, false]);
    expect(results[0]?.content).toEqual([{ type: "text", text: "kaboom" }]);
    expect(results[1]?.content).toEqual([{ type: "text", text: "still here" }]);
  });

  it("sequential: resolves the in-flight call and every queued call as interrupted on abort", async () => {
    const controller = new AbortController();
    const pending = executeTools(
      depsWith([slowTool, echoTool()]),
      {
        calls: [call("c1", "slow"), call("c2", "echo", { message: "never runs" })],
        mode: "sequential",
      },
      controller.signal,
    );
    controller.abort();
    const results = await pending;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Tool execution was interrupted." }]);
    }
  });

  it("runs calls concurrently by default, returning results in call order", async () => {
    // c1 waits on a promise that only c2's execution resolves: this can only
    // complete if both calls run at once — under sequential it would deadlock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiter: Tool = {
      name: "waiter",
      description: "waits for resolver",
      input: z.object({}),
      async execute() {
        await gate;
        return { content: [{ type: "text", text: "waited" }] } satisfies ToolOutcome;
      },
    };
    const resolver: Tool = {
      name: "resolver",
      description: "opens the gate",
      input: z.object({}),
      async execute() {
        release();
        return { content: [{ type: "text", text: "released" }] } satisfies ToolOutcome;
      },
    };
    const results = await executeTools(
      depsWith([waiter, resolver]),
      { calls: [call("c1", "waiter"), call("c2", "resolver")] },
      liveSignal(),
    );
    // c2 finished first; results still follow call order
    expect(results.map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    expect(results[0]?.content).toEqual([{ type: "text", text: "waited" }]);
  });

  it("sequential: starts a call only after the previous one finished", async () => {
    const log: string[] = [];
    const stepper: Tool = {
      name: "stepper",
      description: "logs start/end with a real async gap",
      input: z.object({ label: z.string() }),
      async execute(args) {
        const { label } = args as { label: string };
        log.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        log.push(`end:${label}`);
        return { content: [{ type: "text", text: label }] } satisfies ToolOutcome;
      },
    };
    await executeTools(
      depsWith([stepper]),
      {
        calls: [call("c1", "stepper", { label: "a" }), call("c2", "stepper", { label: "b" })],
        mode: "sequential",
      },
      liveSignal(),
    );
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("parallel: abort interrupts every in-flight call", async () => {
    const controller = new AbortController();
    const pending = executeTools(
      depsWith([slowTool]),
      { calls: [call("c1", "slow"), call("c2", "slow")] },
      controller.signal,
    );
    controller.abort();
    const results = await pending;
    expect(results.map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Tool execution was interrupted." }]);
    }
  });

  it("forwards chunks through onUpdate with the call's identity", async () => {
    const updates: ToolUpdate[] = [];
    await executeTools(
      depsWith([echoTool()], (u) => updates.push(u)),
      { calls: [call("c1", "echo", { message: "hi" })] },
      liveSignal(),
    );
    expect(updates).toEqual([{ toolCallId: "c1", toolName: "echo", chunk: "hi" }]);
  });

  it("is unaffected by a throwing onUpdate tap", async () => {
    const results = await executeTools(
      depsWith([echoTool()], () => {
        throw new Error("broken renderer");
      }),
      { calls: [call("c1", "echo", { message: "hi" })] },
      liveSignal(),
    );
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
