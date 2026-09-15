// apps/worker/src/main.ts — the runDriver host from the ratified P3
// service split, and the only file that touches process.env or the
// network. Pure composition: pg store, one AI SDK inference adapter per
// model-provider key (providers.ts), E2B sandboxes, the four workspace
// tools — handed to FUNKY_CONCURRENCY claim loops, each returning only
// on drain. One signal handler, SIGTERM → drain: stop claiming, give
// every held step FUNKY_DRAIN_MS to commit, else abort it and release
// its lease, then exit. SIGKILL remains the crash story it always was —
// the drain only makes a planned removal (a scale-down, a deploy) cost
// one poll instead of a lease — and the handler is installed once, so a second SIGTERM,
// like anything else, is a crash. Restart policy still belongs to the
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
// Independent loops over one store and one signal: each claims its own
// item (SKIP LOCKED keeps them off each other's rows) and each returns
// holding nothing, so the drain still ends with every lease resolved —
// only now there are up to FUNKY_CONCURRENCY of them, resolved in
// parallel rather than one after another.
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
