// Gated real round-trip against Anthropic. Skipped in CI (no key); run locally with
// ANTHROPIC_API_KEY set to confirm the exec tool round-trips into our ToolCall shape.

import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@funky/db/schema";
import { AiSdkLlm } from "./drivers/ai-sdk";
import type { ChatMessage } from "./port";

const hasKey = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!hasKey)("AiSdkLlm (real anthropic round-trip)", () => {
  const model: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 1024 };

  it("returns an exec ToolCall when the prompt requires a shell command", async () => {
    const llm = new AiSdkLlm();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You control a Linux sandbox. To answer any question about the machine, you MUST call the exec tool. Never guess.",
      },
      { role: "user", content: "What is the current working directory? Use the exec tool." },
    ];

    const result = await llm.complete({ model, messages });

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.toolCall).toBeDefined();
    expect(result.toolCall?.kind).toBe("exec");
    expect(typeof result.toolCall?.cmd).toBe("string");
    expect(result.toolCall?.cmd.length).toBeGreaterThan(0);
  });
});
