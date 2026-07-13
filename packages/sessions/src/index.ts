// packages/sessions — public surface.
//   Phase A: the event model (events.ts).
//   Phase C: the two Postgres-native data-access modules — the event log and the
//   job queue. @funky/sessions is the postgres-touching domain layer; API routes
//   and the (future) reducer still must not import @funky/db.
//   Phase D: the reducer (pure) and the turn / provision loop the worker (Phase E) calls.
export * from "./events";
export { EventStore, ErrConflict } from "./store";
export { JobQueue, onWake, LEASE_MS, HEARTBEAT_MS, POLL_INTERVAL_MS } from "./queue";
export type { Job } from "./queue";
export { nextAction, type Action } from "./reducer";
export { buildContext, runTurn, type TurnDeps, type TurnOutcome } from "./turn";
export { runProvision } from "./provision";
