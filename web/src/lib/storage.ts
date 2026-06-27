// localStorage persistence for the app state.
//
// The REST API exposes no "list agents" or "list history" endpoint — `send` is
// the only call that returns events — so the client is the source of truth for
// what agents/sessions exist and what was said in them. We persist that here so
// it survives reloads, keyed by backend ids.

import type { AppState } from "../types";

const KEY = "funky.web.state.v1";

/** The durable slice of AppState. `modalOpen`/`banner`/`typing` are transient. */
export interface PersistedState {
  agents: AppState["agents"];
  activeAgentId: string | null;
  environmentId: string | null;
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.agents)) return null;
    // A turn can't survive a reload, so any persisted typing flag is stale.
    for (const agent of parsed.agents) {
      for (const session of agent.sessions) session.typing = false;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(state: AppState): void {
  try {
    const toPersist: PersistedState = {
      agents: state.agents,
      activeAgentId: state.activeAgentId,
      environmentId: state.environmentId,
    };
    localStorage.setItem(KEY, JSON.stringify(toPersist));
  } catch {
    // Storage full or unavailable (e.g. private mode): non-fatal, skip persisting.
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
