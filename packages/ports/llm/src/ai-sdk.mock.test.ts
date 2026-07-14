// Offline unit test for the v1 tool-call cap's second layer (defensive truncation). The
// AI SDK's generateText is mocked, so no key / network is needed: we feed a provider
// response carrying THREE tool calls and assert the driver surfaces exactly one and counts
// the drops via llm_tool_calls_dropped_total.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import type { ModelConfig } from "@funky/db/schema";
import { AiSdkLlm } from "./drivers/ai-sdk";
import { getCounter, resetCounters } from "./metrics";
import type { ChatMessage } from "./port";

const MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5" };
const MSGS: ChatMessage[] = [{ role: "user", content: "do three things" }];

function mockResult(toolCalls: Array<{ toolName: string; input: unknown }>) {
  // Only the fields the driver reads; cast past the full GenerateTextResult shape.
  vi.mocked(generateText).mockResolvedValue({
    text: "",
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 4 },
  } as unknown as Awaited<ReturnType<typeof generateText>>);
}

describe("AiSdkLlm parallel-tool-call cap", () => {
  beforeEach(() => {
    resetCounters();
    vi.mocked(generateText).mockReset();
  });

  it("returns exactly one tool call and counts the dropped ones", async () => {
    mockResult([
      { toolName: "exec", input: { cmd: "ls" } },
      { toolName: "exec", input: { cmd: "pwd" } },
      { toolName: "exec", input: { cmd: "whoami" } },
    ]);

    const r = await new AiSdkLlm().complete({ model: MODEL, messages: MSGS });

    expect(r.toolCall).toEqual({ kind: "exec", cmd: "ls" });
    expect(getCounter("llm_tool_calls_dropped_total")).toBe(2); // 3 returned − 1 kept
  });

  it("does not count drops when the provider returns a single call", async () => {
    mockResult([{ toolName: "exec", input: { cmd: "ls" } }]);

    const r = await new AiSdkLlm().complete({ model: MODEL, messages: MSGS });

    expect(r.toolCall).toEqual({ kind: "exec", cmd: "ls" });
    expect(getCounter("llm_tool_calls_dropped_total")).toBe(0);
  });

  it("requests provider-side disable of parallel tool use", async () => {
    mockResult([]);

    await new AiSdkLlm().complete({ model: MODEL, messages: MSGS });

    const call = vi.mocked(generateText).mock.calls[0]![0];
    expect(call.providerOptions).toEqual({ anthropic: { disableParallelToolUse: true } });
  });

  // ai@7 rejects system-role messages in `messages` ("Use the instructions option instead").
  // The system prompt must travel as the top-level `instructions` option instead.
  it("routes the system prompt to `instructions`, never into `messages`", async () => {
    mockResult([]);

    await new AiSdkLlm().complete({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful engineer." },
        { role: "user", content: "hi" },
      ],
    });

    const call = vi.mocked(generateText).mock.calls[0]![0];
    expect(call.instructions).toBe("You are a helpful engineer.");
    expect(call.messages).toEqual([{ role: "user", content: "hi" }]);
    // The regression this guards: no system-role message leaks into `messages`.
    expect((call.messages ?? []).some((m) => m.role === "system")).toBe(false);
  });

  // Anthropic rejects a tool_use.id that isn't ^[a-zA-Z0-9_-]+$. Our idemKey
  // (`sessionId:seq:index`) has colons, so the reconstructed history must sanitize it —
  // identically on the assistant tool-call and its paired tool-result.
  it("sanitizes the tool_use id (no colons) and keeps call/result paired", async () => {
    mockResult([]);

    await new AiSdkLlm().complete({
      model: MODEL,
      messages: [
        { role: "user", content: "run something" },
        { role: "assistant", content: "", toolCall: { kind: "exec", cmd: "echo hi" } },
        { role: "tool", idemKey: "019f5e05-a667-732b-99f6-04fa6a4c38ea:3:0", output: "hi\n", exitCode: 0 },
      ],
    });

    const call = vi.mocked(generateText).mock.calls[0]![0];
    const PATTERN = /^[a-zA-Z0-9_-]+$/;
    // deno-lint style narrowing kept loose: this is test-only shape inspection.
    const assistant = (call.messages ?? []).find((m) => m.role === "assistant")!;
    const toolMsg = (call.messages ?? []).find((m) => m.role === "tool")!;
    const callPart = (assistant.content as Array<{ type: string; toolCallId?: string }>).find(
      (p) => p.type === "tool-call",
    )!;
    const resultPart = (toolMsg.content as Array<{ type: string; toolCallId?: string }>)[0]!;

    expect(callPart.toolCallId).toMatch(PATTERN);
    expect(resultPart.toolCallId).toMatch(PATTERN);
    expect(callPart.toolCallId).not.toContain(":");
    expect(callPart.toolCallId).toBe(resultPart.toolCallId); // must stay paired
  });
});
