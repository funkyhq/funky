import { describe, expect, it } from "vitest";
import { SessionEntry } from "../src/entries";

const envelope = {
  id: "e1",
  seq: 0,
  timestamp: "2026-08-10T12:00:00Z",
};

describe("SessionEntry", () => {
  it("round-trips a message entry wrapping an assistant message with a tool call", () => {
    const entry = {
      ...envelope,
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
        model: "claude-sonnet-5",
        stopReason: "tool_use",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    };
    expect(SessionEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("round-trips a part's provider metadata verbatim, beside the legacy thinking fields", () => {
    const google = { google: { thoughtSignature: "ts-1" } };
    const entry = {
      ...envelope,
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "because",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
          },
          { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
          { type: "text", text: "checking", providerMetadata: google },
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            arguments: { path: "a.ts" },
            providerMetadata: google,
          },
        ],
        model: "gemini-3.7-flash",
        stopReason: "tool_use",
      },
    };
    expect(SessionEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("round-trips a custom entry with a nested payload", () => {
    const entry = {
      ...envelope,
      type: "custom",
      namespace: "review",
      data: { verdict: "approved", scores: [1, 2, 3], nested: { deep: null } },
    };
    expect(SessionEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("round-trips a compaction entry", () => {
    const entry = { ...envelope, type: "compaction", summary: "earlier work…", upToSeq: 41 };
    expect(SessionEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("round-trips a control entry — cancel rides the log, not a flag", () => {
    const entry = { ...envelope, type: "control", control: "cancel" };
    expect(SessionEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  it("rejects an unknown control kind", () => {
    const result = SessionEntry.safeParse({ ...envelope, type: "control", control: "pause" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown entry type", () => {
    const result = SessionEntry.safeParse({ ...envelope, type: "model_change", model: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a message entry whose payload is not a known message role", () => {
    const result = SessionEntry.safeParse({
      ...envelope,
      type: "message",
      message: { role: "system", content: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing envelope field", () => {
    const { seq: _seq, ...withoutSeq } = envelope;
    const result = SessionEntry.safeParse({
      ...withoutSeq,
      type: "compaction",
      summary: "s",
      upToSeq: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = SessionEntry.safeParse({
      ...envelope,
      timestamp: "yesterday",
      type: "custom",
      namespace: "n",
      data: {},
    });
    expect(result.success).toBe(false);
  });
});
