import { describe, expect, it } from "vitest";
import type { AgentMessage, SessionEntry } from "@funky/core";
import { cancelRequested } from "../src/driver/loop";

// cancelRequested is a tail read: while an item is open, only cancels and
// decoration entries can trail the log's last message entry (the
// one-open-item invariant), so the last message-or-control entry decides.
// These logs are the shapes reachable at a driver boundary — the function
// is only defined for callers holding the open item.

const TS = "2026-08-15T00:00:00.000Z";

const user = (): AgentMessage => ({ role: "user", content: [{ type: "text", text: "go" }] });

const assistant = (withCall = false): AgentMessage => ({
  role: "assistant",
  content: withCall
    ? [{ type: "toolCall", id: "call_1", name: "echo", arguments: {} }]
    : [{ type: "text", text: "ok" }],
  model: "m",
  stopReason: withCall ? "tool_use" : "end_turn",
});

const toolResult = (): AgentMessage => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "echo",
  content: [{ type: "text", text: "ok" }],
  isError: false,
});

function log(...items: (AgentMessage | "cancel" | "custom" | "compact")[]): SessionEntry[] {
  return items.map((item, i) => {
    if (item === "cancel") {
      return { id: `e${i}`, seq: i, timestamp: TS, type: "control", control: "cancel" };
    }
    if (item === "custom") {
      return { id: `e${i}`, seq: i, timestamp: TS, type: "custom", namespace: "app", data: null };
    }
    if (item === "compact") {
      return { id: `e${i}`, seq: i, timestamp: TS, type: "compaction", summary: "s", upToSeq: i };
    }
    return { id: `e${i}`, seq: i, timestamp: TS, type: "message", message: item };
  });
}

describe("cancelRequested", () => {
  it("is false when the tail is the batch that created the open item", () => {
    expect(cancelRequested([])).toBe(false);
    expect(cancelRequested(log(user()))).toBe(false);
    expect(cancelRequested(log(user(), assistant(true)))).toBe(false);
    expect(cancelRequested(log(user(), assistant(true), toolResult()))).toBe(false);
  });

  it("is true when cancels trail the last message entry", () => {
    expect(cancelRequested(log(user(), "cancel"))).toBe(true);
    expect(cancelRequested(log(user(), assistant(true), "cancel"))).toBe(true);
    expect(cancelRequested(log(user(), assistant(true), toolResult(), "cancel"))).toBe(true);
    expect(cancelRequested(log(user(), "cancel", "cancel"))).toBe(true);
  });

  it("treats a cancel behind a later message entry as answered", () => {
    // A consumed cancel is always covered before the next consultation:
    // the run it ended creates no item, so the next open item arrives with
    // intake's user entry (or a commit batch) after the cancel in the log.
    expect(cancelRequested(log(user(), "cancel", user()))).toBe(false);
    expect(cancelRequested(log(user(), assistant(), "cancel", user()))).toBe(false);
  });

  it("skips decoration entries when reading the tail", () => {
    expect(cancelRequested(log(user(), "cancel", "custom"))).toBe(true);
    expect(cancelRequested(log(user(), "custom"))).toBe(false);
    // Compaction edits the model's view of history, not the control
    // plane — it never answers (or voids) a pending cancel.
    expect(cancelRequested(log(user(), "cancel", "compact"))).toBe(true);
    expect(cancelRequested(log(user(), "compact"))).toBe(false);
  });

  it("orders by seq, not array position", () => {
    const entries = log(user(), "cancel", user());
    entries.reverse();
    expect(cancelRequested(entries)).toBe(false);
  });
});
