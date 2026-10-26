// apps/worker/src/main.ts — the runDriver host from the ratified P3
// service split, and the only file that touches process.env or the
// network. Pure composition: pg store, one AI SDK inference adapter per
// model-provider key (providers.ts), E2B sandboxes, the Infisical
// secret store when one is configured, the four workspace tools —
// handed to FUNKY_CONCURRENCY drivers run side by side, each returning
// only on drain. The loop knows nothing of its siblings: what makes N
// of them safe is the store (one open item per session, SKIP LOCKED
// claims), so N drivers in one process are N workers sharing a pool.
// One signal handler, SIGTERM → drain: every driver stops claiming, a
// held step gets FUNKY_DRAIN_MS to commit, else it is aborted and its
// lease released, and the process exits once the last has returned.
// SIGKILL remains the crash story it always was — the drain only makes
// a planned removal (a scale-down, a deploy) cost one poll instead of a
// lease — and the handler is installed once, so a second SIGTERM, like
// anything else, is a crash. Restart policy still belongs to the
// container. The e2e suite forks this exact file — what it proves is
// what a container runs.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createSandboxTools,
  type DriverDeps,
  ensureSandbox,
  resolveCredentials,
  runDriver,
  sandboxToolSpecs,
} from "@funky/agent";
import {
  createE2bProvider,
  createInfisicalSecretProvider,
  createPgStore,
  type StoreDb,
} from "@funky/adapters";
import { loadConfig } from "./config";
import { wireProviders } from "./providers";

const cfg = loadConfig();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);
const sandboxes = createE2bProvider({ apiKey: cfg.e2bApiKey });
// Where credentials' keys come from: the store the api's /v1/secrets
// writes to. None configured fails only the runs whose config has
// credentials.
const secrets = cfg.infisical ? createInfisicalSecretProvider(cfg.infisical) : null;
// The registry the driver routes each claim's `inference.provider` on:
// its keys are the providers this worker serves, nothing more.
const providers = wireProviders(cfg.providerKeys);

const deps: DriverDeps = {
  store,
  providers,
  toolSpecs: sandboxToolSpecs,
  // Ensure-on-claim: the loop calls this only for an execute_tools item
  // that will actually execute. The sandbox comes from the agent config
  // version the session pinned at create — immutable, so a later edit
  // cannot reshape a running session's world. Its credentials' keys are
  // read only when a sandbox is created, so a key put or deleted later
  // reaches the session's next sandbox, not the one it has.
  bindTools: async (ref) => {
    const session = await store.getSession(ref);
    if (!session) throw new Error(`worker: unknown session ${ref.sessionId}`);
    const config = await store.getAgentConfig({
      namespace: session.namespace,
      agentConfigId: session.agentConfigId,
      version: session.agentConfigVersion,
    });
    if (!config) throw new Error(`worker: session ${ref.sessionId} has no agent config`);
    const sandbox = await ensureSandbox(store, sandboxes, ref, async () => ({
      timeoutMs: cfg.sandboxTimeoutMs,
      network: config.network,
      packages: config.packages,
      setupCommands: config.setupCommands,
      credentials: await resolveCredentials(secrets, session.namespace, config.credentials),
    }));
    return createSandboxTools(sandbox);
  },
  // A bind failure the driver rides out: logged to stderr, so an outage
  // of the sandbox provider or the secret store shows while it lasts.
  onBindRetry: (ref, error, retryInMs) =>
    console.error(
      `worker: sandbox bind for session ${ref.sessionId} failed; retrying in ${retryInMs}ms:`,
      error,
    ),
};

const drain = new AbortController();
process.once("SIGTERM", () => {
  console.log(`worker: SIGTERM — draining (a held step has ${cfg.drainMs}ms to commit)`);
  drain.abort();
});

console.log(
  `worker: claiming (providers=${[...providers.keys()].join(",")} ` +
    `concurrency=${cfg.concurrency} lease=${cfg.leaseMs}ms ` +
    `idlePoll=${cfg.idlePollMs}ms drain=${cfg.drainMs}ms bindTimeout=${cfg.bindTimeoutMs}ms ` +
    `secrets=${secrets ? "infisical" : "off"})`,
);
// N drivers over one store and one drain signal: each counts the drain
// budget down on its own from the shared signal and awaits its own
// release, so all of them are back before the exit below. A driver's
// failure (a store error outside the fence, or a provider refusing this
// worker's credentials: ProviderConfigError) rejects the whole, and the
// process exits over its siblings — the crash path, as it was with one.
await Promise.all(
  Array.from({ length: cfg.concurrency }, () =>
    runDriver(deps, {
      leaseMs: cfg.leaseMs,
      idlePollMs: cfg.idlePollMs,
      drain: drain.signal,
      drainMs: cfg.drainMs,
      bindTimeoutMs: cfg.bindTimeoutMs,
    }),
  ),
);
console.log("worker: drained — exiting");
// Explicit: an abandoned step (a tool deaf to its abort signal) or the
// pool's open sockets would otherwise keep the event loop alive.
process.exit(0);
