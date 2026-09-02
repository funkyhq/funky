// apps/worker/src/main.ts — the runDriver host from the ratified P3
// service split, and the only file that touches process.env or the
// network. Pure composition: pg store, one AI SDK inference adapter per
// model-provider key (providers.ts), E2B sandboxes, the four workspace
// tools — handed to runDriver, which exits only with the process. No
// drain path and no signal handlers, by design: the crash rule makes
// SIGKILL the shutdown story, so restart policy belongs to the
// container. The e2e suite forks this exact file — what it proves is
// what a container runs.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createSandboxTools,
  type DriverDeps,
  ensureSandbox,
  runDriver,
  sandboxToolSpecs,
} from "@funky/agent";
import { createE2bProvider, createPgStore, type StoreDb } from "@funky/adapters";
import { loadConfig } from "./config";
import { wireProviders } from "./providers";

const cfg = loadConfig();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);
const sandboxes = createE2bProvider({ apiKey: cfg.e2bApiKey });
// The registry the driver routes each claim's `inference.provider` on:
// its keys are the providers this worker serves, nothing more.
const providers = wireProviders(cfg.providerKeys);

const deps: DriverDeps = {
  store,
  providers,
  toolSpecs: sandboxToolSpecs,
  // Ensure-on-claim: the loop calls this only for an execute_tools item
  // that will actually execute. The sandbox recipe is the snapshot the
  // session copied at create, not the env config row it names: env configs
  // update in place, so reloading one could reshape a running session's
  // world. The session carries everything provisioning needs.
  bindTools: async (ref) => {
    const session = await store.getSession(ref);
    if (!session) throw new Error(`worker: unknown session ${ref.sessionId}`);
    const sandbox = await ensureSandbox(store, sandboxes, ref, {
      timeoutMs: cfg.sandboxTimeoutMs,
      network: session.envConfigSnapshot.network,
    });
    return createSandboxTools(sandbox);
  },
};

console.log(
  `worker: claiming (providers=${[...providers.keys()].join(",")} ` +
    `lease=${cfg.leaseMs}ms idlePoll=${cfg.idlePollMs}ms)`,
);
await runDriver(deps, { leaseMs: cfg.leaseMs, idlePollMs: cfg.idlePollMs });
