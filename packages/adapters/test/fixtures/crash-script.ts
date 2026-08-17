// The crash-resume scenario, shared by the parent orchestrator and the
// forked child driver. Everything here must be replay-deterministic: a
// killed child is resumed by a fresh process whose in-memory state
// restarts from zero, so the provider and tools derive *what to answer*
// from the request alone — the log is the only state, for the fixtures
// exactly as for the store. (The call-order-queue provider in
// driver.test.ts is process-local and cannot survive a resume.)
//
// Kill points are an overlay, not part of the script: when a KillSpec
// matches, the component signals `stalled` and parks forever, waiting
// for SIGKILL. A killed child never commits the stalled step, so the
// overlay never perturbs what replay sees.

import { z } from "zod";
import type { ProviderEvent, SessionEntry, Usage, UserMessage } from "@funky/core";
import type { InferenceProvider, Tool } from "@funky/agent";

/**
 * Where the child parks to be killed. `n` indexes within the class:
 * - after-claim / before-commit / after-commit: the child's own claim or
 *   commitStep count, from process start (deterministic given the seed
 *   state the child was forked on);
 * - mid-inference: the script index (= assistant messages in context);
 * - mid-tools: the tool-call index in TOOL_TEXTS.
 */
export interface KillSpec {
  class: "after-claim" | "before-commit" | "after-commit" | "mid-inference" | "mid-tools";
  n: number;
}

export const PROMPTS = ["turn one: go", "turn two: again"] as const;
export const TOOL_TEXTS = ["one", "two"] as const;

export const inferenceConfig = {
  provider: "scripted",
  model: "crash-1",
  maxTokens: 256,
  temperature: 0,
};

export const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const sayText = (text: string): ProviderEvent[] => [
  { type: "text_start", contentIndex: 0 },
  { type: "text_delta", contentIndex: 0, delta: text },
  { type: "text_end", contentIndex: 0 },
  { type: "done", stopReason: "end_turn", usage },
];

const callEcho = (id: string, text: string): ProviderEvent[] => [
  { type: "toolcall_start", contentIndex: 0, toolCallId: id, toolName: "echo" },
  { type: "toolcall_delta", contentIndex: 0, argsDelta: JSON.stringify({ text }) },
  { type: "toolcall_end", contentIndex: 0 },
  { type: "done", stopReason: "tool_use", usage },
];

// Two turns, each inference → tools → inference. Indexed by the number
// of assistant messages already in the request context — the pure
// function of the log that makes replay serve the same answer.
const SCRIPTS: ProviderEvent[][] = [
  callEcho("call_t1", TOOL_TEXTS[0]),
  sayText("turn one done"),
  callEcho("call_t2", TOOL_TEXTS[1]),
  sayText("turn two done"),
];

/** Signal the parent, then park until SIGKILL. */
export const stallForever = (onStall: () => void): Promise<never> => {
  onStall();
  return new Promise<never>(() => {});
};

export interface KillHooks {
  spec?: KillSpec | undefined;
  onStall?: () => void;
}

export function createProvider(hooks: KillHooks = {}): InferenceProvider {
  return {
    async *stream(req) {
      const index = req.context.filter((m) => m.role === "assistant").length;
      const script = SCRIPTS[index];
      if (!script) throw new Error(`crash-script: no script at assistant count ${index}`);
      let emitted = 0;
      for (const event of script) {
        yield event;
        emitted++;
        if (emitted === 1 && hooks.spec?.class === "mid-inference" && hooks.spec.n === index) {
          await stallForever(hooks.onStall ?? (() => {}));
        }
      }
    },
  };
}

export function createTools(hooks: KillHooks = {}): Map<string, Tool> {
  const echo: Tool = {
    name: "echo",
    description: "echoes its input",
    input: z.object({ text: z.string() }),
    execute: async (args) => {
      const text = (args as { text: string }).text;
      const index = TOOL_TEXTS.indexOf(text as (typeof TOOL_TEXTS)[number]);
      if (hooks.spec?.class === "mid-tools" && hooks.spec.n === index) {
        await stallForever(hooks.onStall ?? (() => {}));
      }
      return { content: [{ type: "text", text }] };
    },
  };
  return new Map([[echo.name, echo]]);
}

/**
 * The transcript's normal form: drop the store-minted volatile envelope
 * (id, timestamp), keep seq, type, and the message payload verbatim —
 * payloads are fully scripted, so equality is exact, usage included.
 */
export function normalizeEntries(entries: SessionEntry[]): unknown[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) =>
      entry.type === "message"
        ? { seq: entry.seq, type: entry.type, message: entry.message }
        : { seq: entry.seq, type: entry.type },
    );
}
