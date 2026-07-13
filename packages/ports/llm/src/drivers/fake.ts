// packages/ports/llm/src/drivers/fake.ts — deterministic scripted driver.
//
// The single most-used object in every later test: hand it a script per session and it
// replays turns one per complete() call. No network, no keys, fully deterministic.

import { type LlmPort, type LlmRequest, type LlmResult, LlmTransientError } from "../port";

export type FakeTurn = { content: string; toolCall?: LlmResult["toolCall"] };

export class FakeLlm implements LlmPort {
  private readonly scripts: Record<string, FakeTurn[]>;
  private readonly cursor: Record<string, number> = {};
  private readonly failOnce: Set<number>;
  private readonly fired = new Set<number>();
  private callIndex = 0;

  constructor(opts: {
    scripts: Record<string, FakeTurn[]>; // sessionId → ordered turns
    failOnce?: number[]; // global call-indices that throw LlmTransientError ONCE, then succeed
  }) {
    this.scripts = opts.scripts;
    this.failOnce = new Set(opts.failOnce ?? []);
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const index = this.callIndex++;
    // Transient failure fires BEFORE consuming a script turn: the worker's retry re-calls
    // complete() and gets the same logical turn, just on a later global index.
    if (this.failOnce.has(index) && !this.fired.has(index)) {
      this.fired.add(index);
      throw new LlmTransientError(`fake transient failure at call ${index}`);
    }

    const sessionId = req.trace?.sessionId;
    if (!sessionId) {
      throw new Error("FakeLlm requires req.trace.sessionId to select a script");
    }
    const script = this.scripts[sessionId] ?? [];
    const at = this.cursor[sessionId] ?? 0;
    const turn = script[at];

    // Script exhausted → a terminal turn with no tool call (the turn ends).
    if (!turn) {
      return { content: "done", usage: usageFor(req, "done") };
    }
    this.cursor[sessionId] = at + 1;
    return { content: turn.content, toolCall: turn.toolCall, usage: usageFor(req, turn.content) };
  }
}

// Deterministic, cheap: enough to assert usage flows through, never a real token count.
function usageFor(req: LlmRequest, content: string): LlmResult["usage"] {
  return { inputTokens: req.messages.length, outputTokens: content.length };
}
