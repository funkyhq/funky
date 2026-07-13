// packages/sessions/src/reducer.test.ts — the pure fold. Arrays in, actions out; NO DB.
//
// The reducer is the heart of crash-resume: every valid log prefix must yield exactly the
// action that produced the next event. The ★ RESUME PROPERTY test below proves that for a
// full happy-path log by feeding it EVERY prefix — one assertion covering every crash point.

import { describe, expect, it } from "vitest";
import {
  type ContentBlock,
  type EventPayload,
  type EventType,
  type SessionEvent,
  type ToolCall,
  idemKeyFor,
} from "./events";
import { nextAction } from "./reducer";

const SID = "11111111-1111-1111-1111-111111111111";
const NS = "default";

// A tiny event builder. createdAt is irrelevant to the reducer (it reads type/seq/payload).
function ev<T extends EventType>(seq: number, type: T, payload: EventPayload<T>): SessionEvent<T> {
  return { sessionId: SID, namespace: NS, seq, type, payload, createdAt: new Date(0) };
}

const text = (t: string): ContentBlock[] => [{ type: "text", text: t }];
const EXEC: ToolCall = { kind: "exec", cmd: "echo hi" };

const user = (seq: number) => ev(seq, "user_message", { content: text(`u${seq}`) });
const asstTool = (seq: number) =>
  ev(seq, "assistant_message", { content: [], tool_calls: [EXEC] });
const asstDone = (seq: number) =>
  ev(seq, "assistant_message", { content: text("done"), tool_calls: [] });
const toolResult = (seq: number, forAssistantSeq: number) =>
  ev(seq, "tool_result", {
    idem_key: idemKeyFor(SID, forAssistantSeq, 0),
    output: "hi",
    exit_code: 0,
    truncated: false,
  });
const completed = (seq: number) => ev(seq, "turn_completed", {});
const failed = (seq: number) =>
  ev(seq, "turn_failed", { error_class: "INTERNAL", message: "boom" });
const provisioned = (seq: number) => ev(seq, "session_provisioned", {});

describe("nextAction — the basic transitions", () => {
  it("[user_message] → infer", () => {
    expect(nextAction([user(1)], 20)).toEqual({ kind: "infer" });
  });

  it("[user, assistant(no tools)] → finish", () => {
    expect(nextAction([user(1), asstDone(2)], 20)).toEqual({ kind: "finish" });
  });

  it("[user, assistant(tool_call)] → exec_tool with idemKey `${sessionId}:${seq}:0`", () => {
    const action = nextAction([user(1), asstTool(2)], 20);
    expect(action).toEqual({ kind: "exec_tool", call: EXEC, idemKey: `${SID}:2:0` });
  });

  it("[user, assistant(tool), tool_result] → infer", () => {
    expect(nextAction([user(1), asstTool(2), toolResult(3, 2)], 20)).toEqual({ kind: "infer" });
  });

  it("[user, assistant(tool), tool_result, assistant(no tools)] → finish", () => {
    expect(
      nextAction([user(1), asstTool(2), toolResult(3, 2), asstDone(4)], 20),
    ).toEqual({ kind: "finish" });
  });

  it("[..., turn_completed] → noop (stale job)", () => {
    expect(nextAction([user(1), asstDone(2), completed(3)], 20)).toEqual({ kind: "noop" });
  });

  it("[..., turn_failed] → noop (stale job)", () => {
    expect(nextAction([user(1), failed(2)], 20)).toEqual({ kind: "noop" });
  });

  it("session_provisioned after user_message → infer", () => {
    // A queued user_message whose provision landed after it: still the model's turn.
    expect(nextAction([user(1), provisioned(2)], 20)).toEqual({ kind: "infer" });
  });
});

describe("nextAction — the iteration budget", () => {
  it("maxIterations=2 with 2 assistant messages since the last user → fail(budget)", () => {
    const log = [user(1), asstTool(2), toolResult(3, 2), asstTool(4), toolResult(5, 4)];
    expect(nextAction(log, 2)).toEqual({ kind: "fail", reason: "budget" });
  });

  it("is under budget at 1 of 2 → infer", () => {
    const log = [user(1), asstTool(2), toolResult(3, 2)];
    expect(nextAction(log, 2)).toEqual({ kind: "infer" });
  });

  it("resets per user turn: [user, asst, tool, asst, user] → infer (count restarts)", () => {
    const log = [user(1), asstTool(2), toolResult(3, 2), asstDone(4), user(5)];
    expect(nextAction(log, 2)).toEqual({ kind: "infer" });
  });
});

describe("nextAction — guards", () => {
  it("throws on an empty log", () => {
    expect(() => nextAction([], 20)).toThrow(/empty log/);
  });

  it("a still-pending tool call re-issues the SAME exec_tool (resume after a crash)", () => {
    // The worker died after appending assistant(tool) but before tool_result. Replaying
    // the identical prefix must recompute the identical idemKey → attach, never re-run.
    const log = [user(1), asstTool(2)];
    const a = nextAction(log, 20);
    const b = nextAction(log, 20);
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "exec_tool", call: EXEC, idemKey: `${SID}:2:0` });
  });
});

// ============================================================ ★ RESUME PROPERTY
//
// The single most important reducer test. A complete happy-path turn is a sequence of
// events, each PRODUCED by an action. Feeding every prefix (length 1..N) to nextAction
// must yield exactly the action that produced the NEXT event — which is what a worker
// resuming from any crash point would compute. One test, every crash point.

describe("★ RESUME PROPERTY", () => {
  it("every prefix of a happy-path log yields the action that produced the next event", () => {
    // The full log and, for each prefix length, the action that the reducer should emit —
    // i.e. the action a worker would take to append events[length].
    const log: SessionEvent[] = [
      user(1),
      asstTool(2),
      toolResult(3, 2),
      asstDone(4),
      completed(5),
    ];
    const expectedAfterPrefix: Record<number, ReturnType<typeof nextAction>> = {
      1: { kind: "infer" }, //          [user]                       → produce asstTool(2)
      2: { kind: "exec_tool", call: EXEC, idemKey: `${SID}:2:0` }, // → produce toolResult(3)
      3: { kind: "infer" }, //          [.., tool_result]            → produce asstDone(4)
      4: { kind: "finish" }, //         [.., assistant(no tools)]    → produce turn_completed(5)
      5: { kind: "noop" }, //           [.., turn_completed]         → terminal, stand down
    };

    for (let len = 1; len <= log.length; len++) {
      const prefix = log.slice(0, len);
      expect(nextAction(prefix, 20), `prefix length ${len}`).toEqual(expectedAfterPrefix[len]);
    }
  });

  it("property: nextAction never throws on any non-empty prefix of a valid log", () => {
    // A few structurally distinct valid logs; every non-empty prefix must produce an action.
    const logs: SessionEvent[][] = [
      [user(1), asstDone(2), completed(3)],
      [user(1), asstTool(2), toolResult(3, 2), asstDone(4), completed(5)],
      [user(1), asstTool(2), toolResult(3, 2), asstTool(4), toolResult(5, 4), failed(6)],
      [user(1), provisioned(2), asstTool(3), toolResult(4, 3), asstDone(5), completed(6)],
    ];
    for (const log of logs) {
      for (let len = 1; len <= log.length; len++) {
        expect(() => nextAction(log.slice(0, len), 20)).not.toThrow();
      }
    }
  });
});
