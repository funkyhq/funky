// packages/ports/harness — public surface.
// The worker imports the port; the entrypoint selects a driver by config.

export * from "./port";
export { ClaudeCodeHarness, type ClaudeCodeHarnessOptions } from "./drivers/claude-code";
export {
  DrizzleSessionStore,
  latestSdkSessionId,
  type DrizzleSessionStoreOptions,
} from "./drivers/claude-code-store";

import type { Db } from "@funky/db";
import type { HarnessPort } from "./port";
import { ClaudeCodeHarness } from "./drivers/claude-code";

/** Driver selection at the entrypoint, mirroring makeLlm/makeSandbox. Deliberately a
 *  union of one: the `never` guard below stays a compile error when a driver is added
 *  here but not handled. */
export type HarnessConfig = { db: Db; scratchRoot?: string } & {
  driver: "claude-code";
  apiKey: string;
  cwdRoot?: string;
};

export function makeHarness(cfg: HarnessConfig): HarnessPort {
  switch (cfg.driver) {
    case "claude-code":
      return new ClaudeCodeHarness(cfg);
    default: {
      // Narrows on the discriminant, not `cfg`: a one-member union doesn't narrow to
      // never, and stringifying `cfg` would put the API key in the message.
      const never: never = cfg.driver;
      throw new Error(`unknown harness driver: ${String(never)}`);
    }
  }
}
