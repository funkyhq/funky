// Offline contract test for the Together AI adapter. This exercises the real AI SDK
// provider up to the HTTP boundary and verifies the model id, credential, tools, and
// single-tool-call option that Funky's native loop relies on.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "@funky/db/schema";
import { AiSdkLlm } from "./drivers/ai-sdk";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiSdkLlm (Together AI HTTP contract)", () => {
  it("sends a Together chat completion with the exec tool and parallel calls disabled", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: "completion-test",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-oss-20b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const model: ModelConfig = {
      provider: "togetherai",
      model: "openai/gpt-oss-20b",
    };
    const result = await new AiSdkLlm({ togetherApiKey: "together-test-key" }).complete({
      model,
      messages: [{ role: "user", content: "say done" }],
    });

    expect(result.content).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/chat\/completions$/);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer together-test-key",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe(model.model);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "exec" }),
      }),
    ]);
  });
});
