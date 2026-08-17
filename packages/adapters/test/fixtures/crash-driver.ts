// The crash-resume suite's child process: a real worker — file-backed
// PGlite, the real pg store, real runDriver, real clock — that only
// ever exits by SIGKILL, so even clean teardown goes through the crash
// rule. The parent schedules the crash via CRASH_KILL_SPEC: the store
// wrapper (and the script's provider/tool overlays) signal `stalled` at
// the matching point and park until killed. Every claim and commit is
// reported over IPC so the parent can follow progress without opening
// the data dir (PGlite is single-client — ownership alternates).

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type DriverDeps, runDriver, type Store } from "@funky/agent";
import { createPgStore, type StoreDb } from "../../src";
import { createProvider, createTools, type KillSpec, stallForever } from "./crash-script";

const dataDir = process.env["CRASH_DATA_DIR"];
if (!dataDir) throw new Error("crash-driver: CRASH_DATA_DIR is required");
const specEnv = process.env["CRASH_KILL_SPEC"];
const spec: KillSpec | undefined = specEnv ? (JSON.parse(specEnv) as KillSpec) : undefined;
const leaseMs = Number(process.env["CRASH_LEASE_MS"] ?? 300);

const send = (message: unknown): void => {
  process.send?.(message);
};
const onStall = (): void => send({ t: "stalled", spec });

const client = new PGlite(dataDir);
// Full open (including crash recovery of the copied/killed data dir)
// before announcing readiness — the parent times its kills from the
// `ready` signal, never from fork, because process startup on a cold,
// contended CI runner can outlast any sane kill window.
await client.waitReady;
const store = createPgStore(drizzle({ client }) as unknown as StoreDb);

let claims = 0;
let commits = 0;
const wrapped: Store = {
  ...store,
  claimItem: async (req) => {
    const claim = await store.claimItem(req);
    if (!claim) return claim;
    const n = claims++;
    send({ t: "claimed", n, itemType: claim.item.type });
    if (spec?.class === "after-claim" && spec.n === n) await stallForever(onStall);
    return claim;
  },
  commitStep: async (req) => {
    const n = commits++;
    if (spec?.class === "before-commit" && spec.n === n) await stallForever(onStall);
    await store.commitStep(req);
    send({ t: "committed", n, next: req.next.kind });
    if (spec?.class === "after-commit" && spec.n === n) await stallForever(onStall);
  },
};

const deps: DriverDeps = {
  store: wrapped,
  provider: createProvider({ spec, onStall }),
  tools: createTools({ spec, onStall }),
};

send({ t: "ready" });
await runDriver(deps, { leaseMs, idlePollMs: 25 });
