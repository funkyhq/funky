// packages/ports/harness — public surface.
// The worker imports the port; the entrypoint selects a driver by config.

export * from "./port";
export {
  ClaudeCodeHarness,
  type ClaudeCodeHarnessOptions,
} from "./drivers/claude-code";
export {
  DrizzleSessionStore,
  latestSdkSessionId,
  type DrizzleSessionStoreOptions,
} from "./drivers/claude-code-store";
export { PiHarness, type PiHarnessOptions, type PiProviderKeys } from "./drivers/pi";
export { PiTranscriptStore, type PiTranscriptStoreOptions } from "./drivers/pi-store";

import type { Db } from "@funky/db";
import type { HarnessPort } from "./port";
import { ClaudeCodeHarness } from "./drivers/claude-code";
import { PiHarness, type PiProviderKeys } from "./drivers/pi";

/** Driver selection at the entrypoint, mirroring makeLlm/makeSandbox. */
export type HarnessConfig = { db: Db; scratchRoot?: string } & (
  | { driver: "claude-code"; apiKey: string; cwdRoot?: string }
  | { driver: "pi"; apiKeys: PiProviderKeys }
);

export function makeHarness(cfg: HarnessConfig): HarnessPort {
  switch (cfg.driver) {
    case "claude-code":
      return new ClaudeCodeHarness(cfg);
    case "pi":
      return new PiHarness(cfg);
    default: {
      const never: never = cfg;
      throw new Error(`unknown harness driver: ${JSON.stringify(never)}`);
    }
  }
}
