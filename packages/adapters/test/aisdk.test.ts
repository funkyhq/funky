// The AI SDK adapter against a spec-level mock model — the real
// streamText pipeline runs between the mock and the adapter, so these
// tests cover the adapter's actual seam: spec stream parts in,
// ProviderEvents out, and the request mapping the mock records
// (doStreamCalls) on the way in. The metadata shapes mirror what the
// vendor SDKs actually emit and read: Anthropic's signature as an empty
// reasoning-delta's metadata and redactedData on reasoning-start,
// OpenAI's reasoning item filled in at reasoning-end, Gemini's thought
// signature on every chunk of a block, and providerOptions on replayed
// parts.

import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream, simulateReadableStream } from "ai/test";
import { type AgentMessage, type ProviderEvent, ProviderMetadata } from "@funky/core";
import type { InferenceProvider, StreamRequest } from "@funky/agent";
import { createAiSdkProvider } from "../src";

// The spec-level stream part type, derived through the mock's own option
// type so the test needs no direct @ai-sdk/provider dependency.
type DoStreamOption = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"]
>;
type SpecPart =
  Extract<DoStreamOption, { stream: ReadableStream<unknown> }>["stream"] extends ReadableStream<
    infer T
  >
    ? T
    : never;

const usage = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 },
  outputTokens: { total: 20, text: 15, reasoning: 5 },
};

const finish = (unified: "stop" | "tool-calls" | "length" | "content-filter"): SpecPart => ({
  type: "finish",
  finishReason: { unified, raw: undefined },
  usage,
});

function providerWith(parts: SpecPart[]): {
  provider: InferenceProvider;
  model: MockLanguageModelV3;
} {
  const model = new MockLanguageModelV3({
    doStream: {
      stream: convertArrayToReadableStream<SpecPart>([
        { type: "stream-start", warnings: [] },
        ...parts,
      ]),
    },
  });
  return { provider: createAiSdkProvider({ languageModel: () => model }), model };
}

const request = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: "model-1",
  system: "be brief",
  context: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [],
  ...overrides,
});

const live = (): AbortSignal => new AbortController().signal;

const echoSpec = {
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

async function collect(provider: InferenceProvider, req: StreamRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(req, live())) events.push(event);
  return events;
}

describe("aisdk adapter: stream mapping", () => {
  it("maps a text stream to indexed events and folds usage into done", async () => {
    const { provider } = providerWith([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "0", delta: " world" },
      { type: "text-end", id: "0" },
      finish("stop"),
    ]);

    expect(await collect(provider, request())).toEqual([
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hello" },
      { type: "text_delta", contentIndex: 0, delta: " world" },
      { type: "text_end", contentIndex: 0 },
      {
        type: "done",
        stopReason: "end_turn",
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 5 },
      },
    ]);
  });

  it("maps a tool-call stream; the part id is the tool call id", async () => {
    const { provider } = providerWith([
      { type: "tool-input-start", id: "call_9", toolName: "echo" },
      { type: "tool-input-delta", id: "call_9", delta: '{"text":' },
      { type: "tool-input-delta", id: "call_9", delta: '"hi"}' },
      { type: "tool-input-end", id: "call_9" },
      { type: "tool-call", toolCallId: "call_9", toolName: "echo", input: '{"text":"hi"}' },
      finish("tool-calls"),
    ]);

    const events = await collect(provider, request({ tools: [echoSpec] }));
    expect(events).toEqual([
      { type: "toolcall_start", contentIndex: 0, toolCallId: "call_9", toolName: "echo" },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: '{"text":' },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: '"hi"}' },
      { type: "toolcall_end", contentIndex: 0 },
      expect.objectContaining({ type: "done", stopReason: "tool_use" }),
    ]);
  });

  it("captures the thinking signature from an empty reasoning-delta and delivers it at thinking_end", async () => {
    const { provider } = providerWith([
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", delta: "because" },
      {
        type: "reasoning-delta",
        id: "0",
        delta: "",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      { type: "reasoning-end", id: "0" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      finish("stop"),
    ]);

    const events = await collect(provider, request());
    expect(events.slice(0, 3)).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "because" },
      {
        type: "thinking_end",
        contentIndex: 0,
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
    ]);
    // The following text block gets the next contentIndex.
    expect(events[3]).toEqual({ type: "text_start", contentIndex: 1 });
  });

  it("maps a redacted thinking block to an empty pair carrying the opaque payload", async () => {
    const { provider } = providerWith([
      {
        type: "reasoning-start",
        id: "0",
        providerMetadata: { anthropic: { redactedData: "opaque-payload" } },
      },
      { type: "reasoning-end", id: "0" },
      finish("stop"),
    ]);

    const events = await collect(provider, request());
    expect(events.slice(0, 2)).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      {
        type: "thinking_end",
        contentIndex: 0,
        providerMetadata: { anthropic: { redactedData: "opaque-payload" } },
      },
    ]);
  });

  it("merges metadata across a block's chunks — Gemini attaches its signature to every one", async () => {
    const google = { google: { thoughtSignature: "ts-1" } };
    const { provider } = providerWith([
      { type: "text-start", id: "0", providerMetadata: google },
      { type: "text-delta", id: "0", delta: "Hi", providerMetadata: google },
      { type: "text-end", id: "0" },
      { type: "tool-input-start", id: "call_1", toolName: "echo", providerMetadata: google },
      { type: "tool-input-delta", id: "call_1", delta: '{"text":"hi"}', providerMetadata: google },
      { type: "tool-input-end", id: "call_1", providerMetadata: google },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "echo",
        input: '{"text":"hi"}',
        providerMetadata: google,
      },
      finish("tool-calls"),
    ]);

    const events = await collect(provider, request({ tools: [echoSpec] }));
    expect(events).toEqual([
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hi" },
      { type: "text_end", contentIndex: 0, providerMetadata: google },
      { type: "toolcall_start", contentIndex: 1, toolCallId: "call_1", toolName: "echo" },
      { type: "toolcall_delta", contentIndex: 1, argsDelta: '{"text":"hi"}' },
      { type: "toolcall_end", contentIndex: 1, providerMetadata: google },
      expect.objectContaining({ type: "done", stopReason: "tool_use" }),
    ]);
  });

  it("lets later chunks win — OpenAI fills the encrypted reasoning in at reasoning-end", async () => {
    const { provider } = providerWith([
      {
        type: "reasoning-start",
        id: "0",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
      },
      { type: "reasoning-delta", id: "0", delta: "hmm" },
      {
        type: "reasoning-end",
        id: "0",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
      finish("stop"),
    ]);

    const events = await collect(provider, request());
    expect(events[2]).toEqual({
      type: "thinking_end",
      contentIndex: 0,
      providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
    });
  });

  it("drops undefined at any depth before metadata reaches the log — the Anthropic package emits some", async () => {
    const { provider } = providerWith([
      { type: "tool-input-start", id: "call_1", toolName: "echo" },
      { type: "tool-input-delta", id: "call_1", delta: '{"text":"hi"}' },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "echo",
        input: '{"text":"hi"}',
        providerMetadata: {
          anthropic: {
            caller: { type: "direct", toolId: undefined },
            tags: [{ id: "a", note: undefined }],
          },
          empty: { nothing: undefined },
        },
      },
      finish("tool-calls"),
    ]);

    const events = await collect(provider, request({ tools: [echoSpec] }));
    const end = events.find((event) => event.type === "toolcall_end");
    // toStrictEqual: an `undefined`-valued key is a difference here.
    expect(end).toStrictEqual({
      type: "toolcall_end",
      contentIndex: 0,
      providerMetadata: { anthropic: { caller: { type: "direct" }, tags: [{ id: "a" }] } },
    });
    expect(ProviderMetadata.safeParse(end?.providerMetadata).success).toBe(true);
  });

  it("leaves provider-executed calls to the vendor — streamed or assembled, nothing is surfaced", async () => {
    const { provider } = providerWith([
      { type: "tool-input-start", id: "srv_1", toolName: "web_search", providerExecuted: true },
      { type: "tool-input-delta", id: "srv_1", delta: '{"q":"x"}' },
      { type: "tool-input-end", id: "srv_1" },
      {
        type: "tool-call",
        toolCallId: "srv_1",
        toolName: "web_search",
        input: '{"q":"x"}',
        providerExecuted: true,
      },
      {
        type: "tool-call",
        toolCallId: "srv_2",
        toolName: "code_execution",
        input: "{}",
        providerExecuted: true,
      },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "done" },
      { type: "text-end", id: "0" },
      finish("stop"),
    ]);

    const events = await collect(provider, request());
    expect(events.map((event) => event.type)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("closes a call from the assembled tool-call alone — openai-compatible providers stream no input parts", async () => {
    const { provider } = providerWith([
      {
        type: "tool-call",
        toolCallId: "call_t",
        toolName: "echo",
        input: '{"text":"hi"}',
        providerMetadata: { openaiCompatible: { thoughtSignature: "ts-2" } },
      },
      finish("tool-calls"),
    ]);

    const events = await collect(provider, request({ tools: [echoSpec] }));
    expect(events).toEqual([
      { type: "toolcall_start", contentIndex: 0, toolCallId: "call_t", toolName: "echo" },
      { type: "toolcall_delta", contentIndex: 0, argsDelta: '{"text":"hi"}' },
      {
        type: "toolcall_end",
        contentIndex: 0,
        providerMetadata: { openaiCompatible: { thoughtSignature: "ts-2" } },
      },
      expect.objectContaining({ type: "done", stopReason: "tool_use" }),
    ]);
  });

  it("throws on an error part instead of emitting an event", async () => {
    const { provider } = providerWith([
      { type: "text-start", id: "0" },
      { type: "error", error: new Error("overloaded (529)") },
    ]);

    await expect(collect(provider, request())).rejects.toThrow("overloaded (529)");
  });

  it("throws on outcomes outside the port's vocabulary", async () => {
    const { provider } = providerWith([finish("content-filter")]);
    await expect(collect(provider, request())).rejects.toThrow("content-filter");
  });

  it("throws when the model stream ends without finishing", async () => {
    const { provider } = providerWith([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hel" },
      { type: "text-end", id: "0" },
    ]);

    // streamText guarantees a finish event, synthesizing 'other' for a
    // truncated model stream — which lands in the vocabulary throw, so
    // every truncation path reaches the engine as an exception.
    await expect(collect(provider, request())).rejects.toThrow("other");
  });

  it("surfaces an abort as a throw when the signal fires mid-stream", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream<SpecPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "Hel" },
            { type: "text-delta", id: "0", delta: "lo" },
            { type: "text-end", id: "0" },
            finish("stop"),
          ] satisfies SpecPart[],
          chunkDelayInMs: 20,
        }),
      },
    });
    const provider = createAiSdkProvider({ languageModel: () => model });

    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream(request(), controller.signal)) {
          events.push(event);
          if (event.type === "text_delta") controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});

describe("aisdk adapter: request mapping", () => {
  it("passes model, sampling, system, and tool specs through to the SDK call", async () => {
    const { provider, model } = providerWith([finish("stop")]);
    const inputSchema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    };

    await collect(
      provider,
      request({
        model: "model-x",
        maxTokens: 512,
        temperature: 0.2,
        tools: [{ name: "echo", description: "echoes", inputSchema }],
      }),
    );

    const call = model.doStreamCalls[0]!;
    expect(call.maxOutputTokens).toBe(512);
    expect(call.temperature).toBe(0.2);
    expect(call.prompt[0]).toEqual({ role: "system", content: "be brief" });
    expect(call.tools).toEqual([
      expect.objectContaining({ type: "function", name: "echo", description: "echoes" }),
    ]);
    expect((call.tools?.[0] as { inputSchema: unknown }).inputSchema).toMatchObject(inputSchema);
  });

  it("leaves absent sampling fields absent — the vendor's defaults, never a harness default", async () => {
    const { provider, model } = providerWith([finish("stop")]);
    await collect(provider, request());

    const call = model.doStreamCalls[0]!;
    expect(call.maxOutputTokens).toBeUndefined();
    expect(call.temperature).toBeUndefined();
  });

  it("round-trips each part's metadata verbatim, and legacy thinking fields as Anthropic's", async () => {
    const openai = { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } };
    const google = { google: { thoughtSignature: "ts-1" } };
    const context: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "because", providerMetadata: openai },
          { type: "text", text: "running echo", providerMetadata: google },
          {
            type: "toolCall",
            id: "call_1",
            name: "echo",
            arguments: { text: "hi" },
            providerMetadata: google,
          },
        ],
        model: "model-1",
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "echo",
        content: [{ type: "text", text: "hi" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
          { type: "thinking", thinking: "legacy", thinkingSignature: "sig-1" },
          { type: "text", text: "done" },
        ],
        model: "model-1",
        stopReason: "end_turn",
      },
    ];

    const { provider, model } = providerWith([finish("stop")]);
    await collect(provider, request({ context }));

    // prompt[0] is the system message; the context follows.
    const prompt = model.doStreamCalls[0]!.prompt.slice(1);
    expect(prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "because", providerOptions: openai },
          { type: "text", text: "running echo", providerOptions: google },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "echo",
            input: { text: "hi" },
            providerOptions: google,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "echo",
            output: { type: "text", value: "hi" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { anthropic: { redactedData: "opaque" } },
          },
          {
            type: "reasoning",
            text: "legacy",
            providerOptions: { anthropic: { signature: "sig-1" } },
          },
          { type: "text", text: "done" },
        ],
      },
    ]);
  });

  it("marks failed tool results as error output and filters empty text parts", async () => {
    const context: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "call_1", name: "echo", arguments: {} },
        ],
        model: "model-1",
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "echo",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
    ];

    const { provider, model } = providerWith([finish("stop")]);
    await collect(provider, request({ context }));

    const prompt = model.doStreamCalls[0]!.prompt.slice(1);
    expect(prompt[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "echo", input: {} }],
    });
    expect(prompt[2]).toMatchObject({
      role: "tool",
      content: [expect.objectContaining({ output: { type: "error-text", value: "boom" } })],
    });
  });

  it("resolves the model through the injected factory with the request's model string", async () => {
    const requested: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream<SpecPart>([
          { type: "stream-start", warnings: [] },
          finish("stop"),
        ]),
      },
    });
    const provider = createAiSdkProvider({
      languageModel: (modelId) => {
        requested.push(modelId);
        return model;
      },
    });

    await collect(provider, request({ model: "claude-x" }));
    expect(requested).toEqual(["claude-x"]);
  });
});
