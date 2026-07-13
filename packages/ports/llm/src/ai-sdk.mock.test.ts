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
});
