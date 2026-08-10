// packages/ports/llm — public surface.
// The worker (Phase E) imports the port; the entrypoint selects a driver by config.

export * from "./port";
export { FakeLlm, type FakeTurn } from "./drivers/fake";
export { AiSdkLlm, type AiSdkCredentials } from "./drivers/ai-sdk";
export { getCounter, incrCounter, resetCounters } from "./metrics";

import type { LlmPort } from "./port";
import { AiSdkLlm, type AiSdkCredentials } from "./drivers/ai-sdk";
import type { FakeLlm } from "./drivers/fake";

// Fake construction args come from test setup, not env — so the factory takes the
// already-built driver in tests. The worker entrypoint reads FUNKY_LLM and builds the
// ai-sdk driver from env.
export type LlmConfig =
  { driver: "fake"; instance: FakeLlm } | { driver: "ai-sdk"; credentials: AiSdkCredentials };

export function makeLlm(cfg: LlmConfig): LlmPort {
  switch (cfg.driver) {
    case "fake":
      return cfg.instance;
    case "ai-sdk":
      return new AiSdkLlm(cfg.credentials);
    default: {
      const never: never = cfg;
      throw new Error(`unknown llm driver: ${JSON.stringify(never)}`);
    }
  }
}
