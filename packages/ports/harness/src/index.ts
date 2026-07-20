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

import type { Db } from "@funky/db";
import type { HarnessPort } from "./port";
import { ClaudeCodeHarness } from "./drivers/claude-code";

/** Driver selection at the entrypoint, mirroring makeLlm/makeSandbox. */
export type HarnessConfig = {
  driver: "claude-code";
  db: Db;
  apiKey: string;
  scratchRoot?: string;
  cwdRoot?: string;
};

export function makeHarness(cfg: HarnessConfig): HarnessPort {
  switch (cfg.driver) {
    case "claude-code":
      return new ClaudeCodeHarness(cfg);
    default: {
      const never: never = cfg.driver;
      throw new Error(`unknown harness driver: ${JSON.stringify(never)}`);
    }
  }
}
