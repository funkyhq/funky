import { describe, expect, it } from "vitest";
import type { ProviderEvent, Usage } from "@funky/core";
import { createFakeInferenceProvider, type FakeStep } from "../src/ports/fake-inference-provider";
import { inference, type InferenceRequest } from "../src/engine/inference";

const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const req: InferenceRequest = { model: "test-model", system: "sys", context: [], tools: [] };
const liveSignal = (): AbortSignal => new AbortController().signal;

const run = (script: FakeStep[], onDelta?: (e: ProviderEvent) => void, signal?: AbortSignal) =>
  inference(
    { provider: createFakeInferenceProvider(script), onDelta },
    req,
    signal ?? liveSignal(),
  );

const textScript: FakeStep[] = [
  { type: "text_start", contentIndex: 0 },
  { type: "text_delta", contentIndex: 0, delta: "Hello" },
  { type: "text_delta", contentIndex: 0, delta: " world" },
  { type: "text_end", contentIndex: 0 },
  { type: "done", stopReason: "end_turn", usage },
];

describe("inference", () => {
  it("folds streamed text into one assistant message", async () => {
    const message = await run(textScript);
    expect(message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      model: "test-model",
      stopReason: "end_turn",
      usage,
    });
  });

  it("buffers tool-call argument JSON across deltas and parses at toolcall_end", async () => {
    const message = await run([
      { type: "toolcall_start", contentIndex: 0, toolCallId: "call_1", toolName: "bash" },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: '{"comm' },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: 'and":"ls"}' },
      { type: "toolcall_end", contentIndex: 0 },
      { type: "done", stopReason: "tool_use", usage },
    ]);
    expect(message.stopReason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]);
  });

  it("returns the partial draft with stopReason aborted when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    const pending = run(
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Hel" },
        { kind: "untilAborted" },
      ],
      undefined,
      controller.signal,
    );
    controller.abort();
    const message = await pending;
    expect(message.stopReason).toBe("aborted");
    expect(message.content).toEqual([{ type: "text", text: "Hel" }]);
    expect(message.usage).toBeUndefined();
  });

  it("converts a provider throw into an error message, preserving the partial", async () => {
    const message = await run([
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hel" },
      { kind: "throw", error: new Error("overloaded (529)") },
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("overloaded (529)");
    expect(message.content).toEqual([{ type: "text", text: "Hel" }]);
  });

  it("treats a stream that ends without done as an error", async () => {
    const message = await run([
      { type: "text_start", contentIndex: 0 },
      { type: "text_end", contentIndex: 0 },
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("ended without done");
  });

  it("treats unparseable tool-call arguments as an error", async () => {
    const message = await run([
      { type: "toolcall_start", contentIndex: 0, toolCallId: "call_1", toolName: "bash" },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: '{"command": tru' },
      { type: "toolcall_end", contentIndex: 0 },
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("not valid JSON");
  });

  it("folds a redacted thinking block into an empty part carrying the opaque payload", async () => {
    const message = await run([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_end", contentIndex: 0, signature: "opaque-payload", redacted: true },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "ok" },
      { type: "text_end", contentIndex: 1 },
      { type: "done", stopReason: "end_turn", usage },
    ]);
    expect(message.content).toEqual([
      { type: "thinking", thinking: "", thinkingSignature: "opaque-payload", redacted: true },
      { type: "text", text: "ok" },
    ]);
  });

  it("taps every provider event, in order", async () => {
    const seen: string[] = [];
    await run(textScript, (e) => seen.push(e.type));
    expect(seen).toEqual(["text_start", "text_delta", "text_delta", "text_end", "done"]);
  });

  it("is unaffected by a throwing tap", async () => {
    const message = await run(textScript, () => {
      throw new Error("broken renderer");
    });
    expect(message.stopReason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
  });
});
