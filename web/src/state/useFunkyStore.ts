// The app store: a reducer for the (nested) agent/session state plus the async
// actions that drive the backend flow — create agent → create environment →
// create session → send a turn. Components call the actions; the actions call
// the REST client and dispatch the results.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { api, describeError } from "../api/client";
import { eventsToItems } from "../lib/events";
import { avatarLetter } from "../lib/avatar";
import { clearState, loadState, saveState } from "../lib/storage";
import type { Agent, AppState, ChatItem, Session } from "../types";

function newSession(id: string, n: number): Session {
  return {
    id,
    title: `Session ${String(n).padStart(2, "0")}`,
    items: [],
    composer: "",
    typing: false,
  };
}

// ---- reducer ----------------------------------------------------------------

type Action =
  | { type: "openModal" }
  | { type: "closeModal" }
  | { type: "setBanner"; text: string | null }
  | { type: "reset" }
  | { type: "setEnvironment"; environmentId: string }
  | { type: "addAgent"; agent: Agent }
  | { type: "selectAgent"; agentId: string }
  | { type: "selectSession"; agentId: string; sessionId: string }
  | { type: "addSession"; agentId: string; session: Session }
  | { type: "setComposer"; agentId: string; sessionId: string; text: string }
  | { type: "appendItems"; agentId: string; sessionId: string; items: ChatItem[] }
  | { type: "setTyping"; agentId: string; sessionId: string; typing: boolean };

function mapAgent(state: AppState, agentId: string, fn: (a: Agent) => Agent): AppState {
  return { ...state, agents: state.agents.map((a) => (a.id === agentId ? fn(a) : a)) };
}

function mapSession(
  state: AppState,
  agentId: string,
  sessionId: string,
  fn: (s: Session) => Session,
): AppState {
  return mapAgent(state, agentId, (a) => ({
    ...a,
    sessions: a.sessions.map((s) => (s.id === sessionId ? fn(s) : s)),
  }));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "openModal":
      return { ...state, modalOpen: true };
    case "closeModal":
      return { ...state, modalOpen: false };
    case "setBanner":
      return { ...state, banner: action.text };
    case "reset":
      return { agents: [], activeAgentId: null, environmentId: null, modalOpen: false, banner: null };
    case "setEnvironment":
      return { ...state, environmentId: action.environmentId };
    case "addAgent":
      return {
        ...state,
        agents: [...state.agents, action.agent],
        activeAgentId: action.agent.id,
      };
    case "selectAgent":
      return { ...state, activeAgentId: action.agentId };
    case "selectSession":
      return mapAgent(state, action.agentId, (a) => ({ ...a, activeSessionId: action.sessionId }));
    case "addSession":
      return mapAgent(state, action.agentId, (a) => ({
        ...a,
        sessions: [...a.sessions, action.session],
        activeSessionId: action.session.id,
      }));
    case "setComposer":
      return mapSession(state, action.agentId, action.sessionId, (s) => ({ ...s, composer: action.text }));
    case "appendItems":
      return mapSession(state, action.agentId, action.sessionId, (s) => ({
        ...s,
        items: [...s.items, ...action.items],
      }));
    case "setTyping":
      return mapSession(state, action.agentId, action.sessionId, (s) => ({ ...s, typing: action.typing }));
  }
}

function initState(): AppState {
  const persisted = loadState();
  return {
    agents: persisted?.agents ?? [],
    activeAgentId: persisted?.activeAgentId ?? null,
    environmentId: persisted?.environmentId ?? null,
    modalOpen: false,
    banner: null,
  };
}

// ---- hook -------------------------------------------------------------------

export interface CreateAgentDraft {
  name: string;
  modelId: string;
  systemPrompt: string;
}

export function useFunkyStore() {
  const [state, dispatch] = useReducer(reducer, undefined, initState);

  // Async actions read the freshest state through a ref to avoid stale closures.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Persist the durable state whenever it changes.
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Resolve (and cache) the shared environment id, creating one if needed.
  const ensureEnvironment = useCallback(async (): Promise<string> => {
    const existing = stateRef.current.environmentId;
    if (existing) return existing;
    const { id } = await api.createEnvironment();
    dispatch({ type: "setEnvironment", environmentId: id });
    return id;
  }, []);

  const openModal = useCallback(() => dispatch({ type: "openModal" }), []);
  const closeModal = useCallback(() => dispatch({ type: "closeModal" }), []);
  const clearBanner = useCallback(() => dispatch({ type: "setBanner", text: null }), []);
  const selectAgent = useCallback((agentId: string) => dispatch({ type: "selectAgent", agentId }), []);
  const selectSession = useCallback(
    (agentId: string, sessionId: string) => dispatch({ type: "selectSession", agentId, sessionId }),
    [],
  );
  const setComposer = useCallback(
    (agentId: string, sessionId: string, text: string) =>
      dispatch({ type: "setComposer", agentId, sessionId, text }),
    [],
  );

  // Create an agent (+ its first session) on the backend, then add it locally.
  // Throws on failure so the modal can show the error and stay open.
  const createAgent = useCallback(
    async (draft: CreateAgentDraft): Promise<void> => {
      const name = draft.name.trim();
      if (!name || !draft.modelId) return;

      const envId = await ensureEnvironment();
      const { id: agentId } = await api.createAgent({
        name,
        model: draft.modelId,
        system_prompt: draft.systemPrompt,
      });
      const { id: sessionId } = await api.createSession(agentId, envId);

      const agent: Agent = {
        id: agentId,
        name,
        modelId: draft.modelId,
        systemPrompt: draft.systemPrompt,
        avatarLetter: avatarLetter(name),
        sessions: [newSession(sessionId, 1)],
        activeSessionId: sessionId,
      };
      dispatch({ type: "addAgent", agent });
      dispatch({ type: "closeModal" });
    },
    [ensureEnvironment],
  );

  // Open a new session for an agent and switch to it. Surfaces errors as a toast.
  const createSession = useCallback(
    async (agentId: string): Promise<void> => {
      try {
        const envId = await ensureEnvironment();
        const { id } = await api.createSession(agentId, envId);
        const agent = stateRef.current.agents.find((a) => a.id === agentId);
        const n = (agent?.sessions.length ?? 0) + 1;
        dispatch({ type: "addSession", agentId, session: newSession(id, n) });
      } catch (err) {
        dispatch({ type: "setBanner", text: describeError(err, "Couldn't open a new session.") });
      }
    },
    [ensureEnvironment],
  );

  // Send the active session's composed text as one agent turn.
  const sendMessage = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    const agent = s.agents.find((a) => a.id === s.activeAgentId);
    const session = agent?.sessions.find((x) => x.id === agent.activeSessionId);
    if (!agent || !session) return;

    const text = session.composer.trim();
    if (!text || session.typing) return;

    const agentId = agent.id;
    const sessionId = session.id;

    // Optimistically show the user's bubble, clear the input, start the dots.
    dispatch({
      type: "appendItems",
      agentId,
      sessionId,
      items: [{ kind: "user", id: crypto.randomUUID(), text }],
    });
    dispatch({ type: "setComposer", agentId, sessionId, text: "" });
    dispatch({ type: "setTyping", agentId, sessionId, typing: true });

    try {
      const res = await api.sendMessage(sessionId, text);
      const items = eventsToItems(res.events ?? []);
      if (items.length === 0) {
        items.push({ kind: "agent", id: crypto.randomUUID(), text: "(the agent returned no message)" });
      }
      dispatch({ type: "appendItems", agentId, sessionId, items });
    } catch (err) {
      dispatch({
        type: "appendItems",
        agentId,
        sessionId,
        items: [
          { kind: "error", id: crypto.randomUUID(), text: describeError(err, "Something went wrong sending that message.") },
        ],
      });
    } finally {
      dispatch({ type: "setTyping", agentId, sessionId, typing: false });
    }
  }, []);

  // Wipe local agents/sessions/history (e.g. after the backend was reset).
  const reset = useCallback(() => {
    const ok = window.confirm(
      "Clear all locally-stored agents, sessions, and chat history? This can't be undone.",
    );
    if (!ok) return;
    clearState();
    dispatch({ type: "reset" });
  }, []);

  const activeAgent = state.agents.find((a) => a.id === state.activeAgentId) ?? null;
  const activeSession = activeAgent
    ? activeAgent.sessions.find((s) => s.id === activeAgent.activeSessionId) ?? null
    : null;

  const actions = useMemo(
    () => ({
      openModal,
      closeModal,
      clearBanner,
      selectAgent,
      selectSession,
      setComposer,
      createAgent,
      createSession,
      sendMessage,
      reset,
    }),
    [
      openModal,
      closeModal,
      clearBanner,
      selectAgent,
      selectSession,
      setComposer,
      createAgent,
      createSession,
      sendMessage,
      reset,
    ],
  );

  return { state, activeAgent, activeSession, actions };
}

export type FunkyActions = ReturnType<typeof useFunkyStore>["actions"];
