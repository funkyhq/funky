// Unit tests for the FakeLlm — the deterministic scripted driver every later phase leans
// on. Two guarantees: a per-session script replays one turn per complete() call, and
// failOnce throws a transient error exactly once at a given global call index.

import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@funky/db/schema";
import { FakeLlm } from "./drivers/fake";
import { LlmTransientError } from "./port";
import type { ChatMessage } from "./port";

const MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5" };
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

function req(sessionId: string) {
  return { model: MODEL, messages: MSGS, trace: { sessionId } };
}

describe("FakeLlm", () => {
  it("replays a 3-turn script for one session, then goes terminal", async () => {
    const llm = new FakeLlm({
      scripts: {
        s1: [
          { content: "step 1", toolCall: { kind: "exec", cmd: "ls" } },
          { content: "step 2", toolCall: { kind: "exec", cmd: "cat file" } },
          { content: "step 3" },
        ],
      },
    });

    const r1 = await llm.complete(req("s1"));
    expect(r1.content).toBe("step 1");
    expect(r1.toolCall).toEqual({ kind: "exec", cmd: "ls" });

    const r2 = await llm.complete(req("s1"));
    expect(r2.content).toBe("step 2");
    expect(r2.toolCall).toEqual({ kind: "exec", cmd: "cat file" });

    const r3 = await llm.complete(req("s1"));
    expect(r3.content).toBe("step 3");
    expect(r3.toolCall).toBeUndefined();

    // Script exhausted → terminal turn with no tool call, forever.
    const r4 = await llm.complete(req("s1"));
    expect(r4.content).toBe("done");
    expect(r4.toolCall).toBeUndefined();

    expect(r1.usage).toEqual({ inputTokens: 1, outputTokens: "step 1".length });
  });

  it("keeps a separate cursor per session", async () => {
    const llm = new FakeLlm({
      scripts: { a: [{ content: "a1" }, { content: "a2" }], b: [{ content: "b1" }] },
    });
    expect((await llm.complete(req("a"))).content).toBe("a1");
    expect((await llm.complete(req("b"))).content).toBe("b1");
    expect((await llm.complete(req("a"))).content).toBe("a2");
  });

  it("failOnce throws a transient error exactly once, then succeeds", async () => {
    const llm = new FakeLlm({ scripts: { s1: [{ content: "ok" }] }, failOnce: [0] });

    await expect(llm.complete(req("s1"))).rejects.toBeInstanceOf(LlmTransientError);

    // The retry (call index 1) is no longer failed and delivers the first script turn.
    const r = await llm.complete(req("s1"));
    expect(r.content).toBe("ok");
  });

  it("runs the DEFAULT_SCRIPT for a session it has no explicit script for", async () => {
    // The zero-key demo path: no scripts registered, so any session gets the default —
    // a real exec, then a summary turn, then terminal "done".
    const llm = new FakeLlm({ scripts: {} });

    const r1 = await llm.complete(req("unknown"));
    expect(r1.content).toBe("");
    expect(r1.toolCall).toEqual({ kind: "exec", cmd: 'echo "hello from the funky sandbox"; uname -a' });

    const r2 = await llm.complete(req("unknown"));
    expect(r2.content).toMatch(/ran a command in the sandbox/);
    expect(r2.toolCall).toBeUndefined();

    const r3 = await llm.complete(req("unknown"));
    expect(r3.content).toBe("done");
    expect(r3.toolCall).toBeUndefined();
  });

  it("an explicit per-session script still wins over the default", async () => {
    const llm = new FakeLlm({ scripts: { s1: [{ content: "explicit" }] } });
    expect((await llm.complete(req("s1"))).content).toBe("explicit");
    // A different, unregistered session still gets the default's first tool turn.
    expect((await llm.complete(req("s2"))).toolCall).toEqual({
      kind: "exec",
      cmd: 'echo "hello from the funky sandbox"; uname -a',
    });
  });

  it("requires trace.sessionId to pick a script", async () => {
    const llm = new FakeLlm({ scripts: { s1: [{ content: "ok" }] } });
    await expect(llm.complete({ model: MODEL, messages: MSGS })).rejects.toThrow(/sessionId/);
  });
});
