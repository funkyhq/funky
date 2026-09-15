// apps/worker/src/main.ts — the runDriver host from the ratified P3
// service split, and the only file that touches process.env or the
// network. Pure composition: pg store, one AI SDK inference adapter per
// model-provider key (providers.ts), E2B sandboxes, the four workspace
// tools — handed to FUNKY_CONCURRENCY drivers run side by side, each
// returning only on drain. The loop knows nothing of its siblings: what
// makes N of them safe is the store (one open item per session, SKIP
// LOCKED claims), so N drivers in one process are N workers sharing a
// pool. One signal handler, SIGTERM → drain: every driver stops
// claiming, a held step gets FUNKY_DRAIN_MS to commit, else it is
// aborted and its lease released, and the process exits once the last
// has returned. SIGKILL remains the crash story it always was — the
// drain only makes a planned removal (a scale-down, a deploy) cost one
// poll instead of a lease — and the handler is installed once, so a
// second SIGTERM, like anything else, is a crash. Restart policy still
// belongs to the container. The e2e suite forks this exact file — what
// it proves is what a container runs.

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

const drain = new AbortController();
process.once("SIGTERM", () => {
  console.log(`worker: SIGTERM — draining (a held step has ${cfg.drainMs}ms to commit)`);
  drain.abort();
});

console.log(
  `worker: claiming (providers=${[...providers.keys()].join(",")} ` +
    `concurrency=${cfg.concurrency} lease=${cfg.leaseMs}ms ` +
    `idlePoll=${cfg.idlePollMs}ms drain=${cfg.drainMs}ms)`,
);
// N drivers over one store and one drain signal: each counts the drain
// budget down on its own from the shared signal and awaits its own
// release, so all of them are back before the exit below. A driver's
// failure (a store error outside the fence) rejects the whole, and the
// process exits over its siblings — the crash path, as it was with one.
await Promise.all(
  Array.from({ length: cfg.concurrency }, () =>
    runDriver(deps, {
      leaseMs: cfg.leaseMs,
      idlePollMs: cfg.idlePollMs,
      drain: drain.signal,
      drainMs: cfg.drainMs,
    }),
  ),
);
console.log("worker: drained — exiting");
// Explicit: an abandoned step (a tool deaf to its abort signal) or the
// pool's open sockets would otherwise keep the event loop alive.
process.exit(0);
