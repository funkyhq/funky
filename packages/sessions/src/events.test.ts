// Unit tests for the Phase A event model. These are the contract the DB rows are
// stored against: every append goes through makeEvent(), every read through
// parseEvent(). The round-trip below is the guarantee that a written event reads
// back identically for every event type — and that the two deliberately
// future-proofed shapes (ContentBlock[] content, capped-array tool_calls) hold.

import { describe, expect, it } from "vitest";
import {
  type EventPayload,
  type EventType,
  eventPayloadSchemas,
  idemKeyFor,
  makeEvent,
  parseEvent,
  plainText,
  textContent,
} from "./events";

const base = { sessionId: "11111111-1111-1111-1111-111111111111", namespace: "default", seq: 1 };
const createdAt = new Date("2026-07-13T00:00:00.000Z");

// One valid payload per event type. Keyed by EventType so the exhaustiveness
// check below fails loudly if a new event type is added without a sample here.
const samples: { [T in EventType]: EventPayload<T> } = {
  user_message: { content: [{ type: "text", text: "hello" }] },
  assistant_message: {
    content: [{ type: "text", text: "on it" }],
    tool_calls: [{ kind: "exec", cmd: "ls -la" }],
    usage: { input_tokens: 12, output_tokens: 34 },
  },
  tool_result: { idem_key: idemKeyFor(base.sessionId, 2), output: "total 0", exit_code: 0, truncated: false },
  turn_completed: {},
  turn_failed: { error_class: "INTERNAL", message: "boom" },
  session_provisioned: {},
  harness_attempt_started: {
    attempt: "22222222-2222-2222-2222-222222222222",
    resumed_from: null,
  },
};

describe("event model coverage", () => {
  it("has a sample payload for every event type", () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(eventPayloadSchemas).sort());
  });
});

describe("makeEvent → parseEvent round-trip", () => {
  for (const type of Object.keys(samples) as EventType[]) {
    it(`round-trips ${type}`, () => {
      const made = makeEvent(base, type, samples[type]);
      expect(made).toEqual({ ...base, type, payload: samples[type] });

      // Simulate the DB row: envelope columns + jsonb payload + created_at.
      const parsed = parseEvent({ ...made, createdAt, payload: made.payload });
      expect(parsed.sessionId).toBe(base.sessionId);
      expect(parsed.seq).toBe(base.seq);
      expect(parsed.namespace).toBe(base.namespace);
      expect(parsed.type).toBe(type);
      expect(parsed.createdAt).toBe(createdAt);
      expect(parsed.payload).toEqual(made.payload);
    });
  }

  it("fills schema defaults on read (assistant_message.tool_calls, tool_result.truncated)", () => {
    // A jsonb row that predates a field, or a producer that omits a defaulted one,
    // must read back with the default applied — the defaults live on the parse path.
    const asst = parseEvent({
      ...base,
      type: "assistant_message",
      payload: { content: [{ type: "text", text: "hi" }] }, // no tool_calls
      createdAt,
    });
    expect((asst.payload as EventPayload<"assistant_message">).tool_calls).toEqual([]); // .default([])

    const res = parseEvent({
      ...base,
      type: "tool_result",
      payload: { idem_key: "k", output: "o", exit_code: 0 }, // no truncated
      createdAt,
    });
    expect((res.payload as EventPayload<"tool_result">).truncated).toBe(false); // .default(false)
  });
});

describe("parseEvent guards", () => {
  it("throws on an unknown event type", () => {
    expect(() =>
      parseEvent({ ...base, type: "not_a_real_type", payload: {}, createdAt }),
    ).toThrow(/unknown event type in log: not_a_real_type/);
  });

  it("throws on a payload that violates its schema", () => {
    // user_message requires content.min(1); an empty array must be rejected on read.
    expect(() =>
      parseEvent({ ...base, type: "user_message", payload: { content: [] }, createdAt }),
    ).toThrow();
  });
});

describe("tool_calls v1 cap", () => {
  it("rejects an assistant_message with two tool_calls", () => {
    expect(() =>
      makeEvent(base, "assistant_message", {
        content: [],
        tool_calls: [
          { kind: "exec", cmd: "ls" },
          { kind: "exec", cmd: "pwd" },
        ],
      }),
    ).toThrow();
  });

  it("accepts exactly one tool_call", () => {
    const made = makeEvent(base, "assistant_message", {
      content: [],
      tool_calls: [{ kind: "exec", cmd: "ls" }],
    });
    expect(made.payload.tool_calls).toHaveLength(1);
  });
});

describe("idemKeyFor", () => {
  it("is deterministic and includes the trailing :index (default 0)", () => {
    expect(idemKeyFor("sess", 7)).toBe("sess:7:0");
    expect(idemKeyFor("sess", 7)).toBe(idemKeyFor("sess", 7));
  });

  it("carries a non-zero index in the suffix", () => {
    expect(idemKeyFor("sess", 7, 2)).toBe("sess:7:2");
  });
});

describe("textContent / plainText", () => {
  it("wraps a string into a single text block", () => {
    expect(textContent("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("round-trips through plainText", () => {
    expect(plainText(textContent("hello world"))).toBe("hello world");
  });

  it("concatenates multiple text blocks in order", () => {
    expect(plainText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])).toBe("ab");
  });
});
