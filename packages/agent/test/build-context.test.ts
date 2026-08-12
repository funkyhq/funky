import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  AssistantMessage,
  SessionEntry,
  StopReason,
  ToolResultMessage,
  UserMessage,
} from "@funky/core";
import { buildContext } from "../src/build-context";

const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistant = (
  stopReason: StopReason,
  content: AssistantMessage["content"] = [{ type: "text", text: "ok" }],
): AssistantMessage => ({
  role: "assistant",
  content,
  model: "test-model",
  stopReason,
});

const toolCall = (id: string) => ({
  type: "toolCall" as const,
  id,
  name: "echo",
  arguments: {},
});

const toolResult = (toolCallId: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "echo",
  content: [{ type: "text", text: "done" }],
  isError: false,
});

const interrupted = (toolCallId: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "echo",
  content: [{ type: "text", text: "Tool execution was interrupted." }],
  isError: true,
});

const entry = (seq: number, message: AgentMessage): SessionEntry => ({
  id: `e${seq}`,
  seq,
  timestamp: "2026-08-10T12:00:00Z",
  type: "message",
  message,
});

describe("buildContext", () => {
  it("folds message entries in seq order", () => {
    const a = assistant("end_turn");
    expect(buildContext([entry(0, user("hi")), entry(1, a)])).toEqual([user("hi"), a]);
  });

  it("sorts by seq, not array order", () => {
    const a = assistant("end_turn");
    expect(buildContext([entry(1, a), entry(0, user("hi"))])).toEqual([user("hi"), a]);
  });

  it("keeps a complete tool round-trip intact", () => {
    const asking = assistant("tool_use", [toolCall("c1")]);
    const done = assistant("end_turn");
    const context = buildContext([
      entry(0, user("go")),
      entry(1, asking),
      entry(2, toolResult("c1")),
      entry(3, done),
    ]);
    expect(context).toEqual([user("go"), asking, toolResult("c1"), done]);
  });

  it("skips custom entries", () => {
    const custom: SessionEntry = {
      id: "e1",
      seq: 1,
      timestamp: "2026-08-10T12:00:00Z",
      type: "custom",
      namespace: "billing",
      data: { plan: "pro" },
    };
    expect(buildContext([entry(0, user("hi")), custom])).toEqual([user("hi")]);
  });

  it("skips control entries — cancel never reaches the model", () => {
    const control: SessionEntry = {
      id: "e1",
      seq: 1,
      timestamp: "2026-08-10T12:00:00Z",
      type: "control",
      control: "cancel",
    };
    expect(buildContext([entry(0, user("hi")), control])).toEqual([user("hi")]);
  });

  it("treats compaction entries as a no-op for now", () => {
    const compaction: SessionEntry = {
      id: "e1",
      seq: 1,
      timestamp: "2026-08-10T12:00:00Z",
      type: "compaction",
      summary: "earlier work…",
      upToSeq: 0,
    };
    expect(buildContext([entry(0, user("hi")), compaction])).toEqual([user("hi")]);
  });

  it("drops aborted and error assistant messages from context", () => {
    const good = assistant("end_turn");
    const context = buildContext([
      entry(0, user("hi")),
      entry(1, assistant("aborted")),
      entry(2, user("again")),
      entry(3, assistant("error")),
      entry(4, user("once more")),
      entry(5, good),
    ]);
    expect(context).toEqual([user("hi"), user("again"), user("once more"), good]);
  });

  it("drops results orphaned by a dropped assistant message", () => {
    const context = buildContext([
      entry(0, user("hi")),
      entry(1, assistant("aborted", [toolCall("c1")])),
      entry(2, toolResult("c1")),
    ]);
    expect(context).toEqual([user("hi")]);
  });

  it("synthesizes interrupted results for calls with no committed results", () => {
    const asking = assistant("tool_use", [toolCall("c1"), toolCall("c2")]);
    const context = buildContext([entry(0, user("go")), entry(1, asking)]);
    expect(context).toEqual([user("go"), asking, interrupted("c1"), interrupted("c2")]);
  });

  it("synthesizes only the missing results, after the committed ones", () => {
    const asking = assistant("tool_use", [toolCall("c1"), toolCall("c2")]);
    const context = buildContext([entry(0, asking), entry(1, toolResult("c1"))]);
    expect(context).toEqual([asking, toolResult("c1"), interrupted("c2")]);
  });

  it("closes dangling calls before the next message, not at the end", () => {
    const asking = assistant("tool_use", [toolCall("c1")]);
    const followUp = user("follow-up");
    const answer = assistant("end_turn");
    const context = buildContext([entry(0, asking), entry(1, followUp), entry(2, answer)]);
    expect(context).toEqual([asking, interrupted("c1"), followUp, answer]);
  });

  it("appends steering messages at the tail, in order", () => {
    const a = assistant("end_turn");
    const context = buildContext(
      [entry(0, user("hi")), entry(1, a)],
      [user("steer one"), user("steer two")],
    );
    expect(context).toEqual([user("hi"), a, user("steer one"), user("steer two")]);
  });

  it("closes dangling calls before appending steering messages", () => {
    const asking = assistant("tool_use", [toolCall("c1")]);
    const context = buildContext([entry(0, asking)], [user("steer")]);
    expect(context).toEqual([asking, interrupted("c1"), user("steer")]);
  });

  it("builds from steering alone when the log is empty", () => {
    expect(buildContext([], [user("first")])).toEqual([user("first")]);
  });

  it("returns an empty context for an empty log", () => {
    expect(buildContext([])).toEqual([]);
  });
});
