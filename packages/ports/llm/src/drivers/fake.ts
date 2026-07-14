// packages/ports/llm/src/drivers/fake.ts — deterministic scripted driver.
//
// The single most-used object in every later test: hand it a script per session and it
// replays turns one per complete() call. No network, no keys, fully deterministic.

import { type LlmPort, type LlmRequest, type LlmResult, LlmTransientError } from "../port";

export type FakeTurn = { content: string; toolCall?: LlmResult["toolCall"] };

// The script used for any session with no explicit script — i.e. the zero-key demo path.
// A fresh `docker compose up` (FUNKY_LLM=fake, no ANTHROPIC_API_KEY) drives THIS: the agent
// runs a real command in the sandbox, then reports back. Deterministic on purpose — this is
// a demo, not a simulation. Tests that register their own per-session script still win.
const DEFAULT_SCRIPT: FakeTurn[] = [
  {
    content: "",
    toolCall: { kind: "exec", cmd: 'echo "hello from the funky sandbox"; uname -a' },
  },
  { content: "I ran a command in the sandbox. It said hello, and reported the kernel." },
];

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
    // Explicit per-session script wins; otherwise an unknown session runs the DEFAULT_SCRIPT
    // (the zero-key demo). Both are consumed in order via the same per-session cursor.
    const script = this.scripts[sessionId] ?? DEFAULT_SCRIPT;
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
