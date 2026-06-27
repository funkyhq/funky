# funky-web

**Funky** — a browser chat UI for creating and talking to AI agents, in a minimal
pixel-art / retro-game style. A Vite + React + TypeScript frontend for the local
Funky client ([`client/local_python`](../client/local_python)).

It drives the client's REST API end to end: create an agent, open a session, and
send messages — each message runs one real agent turn (a billed Anthropic call in
a fresh Docker sandbox) and the response streams back into the chat.

![three states: first run, the New Agent modal, and a live conversation]

## Prerequisites

The frontend talks to the Funky **client** on `:8000`. Bring up the whole local
stack from the repo root first:

```bash
cd ..                        # repo root
cp .env.example .env         # then put your ANTHROPIC_API_KEY in it
docker compose up --build    # client on :8000, four backends behind it
```

(See the [repo README](../README.md) for what the stack is.)

## Run the frontend

```bash
npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173 and click **+ NEW AGENT** (it's pre-filled with a
sample). Create it, then type a message and hit **SEND** (or Enter).

### How it connects (no CORS, no backend changes)

The Funky client ships no CORS headers, so instead of calling it cross-origin the
Vite dev server **proxies** the API paths to it (see `vite.config.ts`):

```
browser ──/v1/*, /health──> Vite dev server (:5173) ──proxy──> client (:8000)
```

So the app only ever makes same-origin requests. Point the proxy at a client on a
different host/port with `VITE_API_TARGET`:

```bash
VITE_API_TARGET=http://192.168.1.50:8000 npm run dev
```

(`.env.example` lists the available overrides.)

## What it does

The four-step flow from the client's REST API, wired to the UI:

| UI action | Calls |
|---|---|
| **+ NEW AGENT** → CREATE | `POST /v1/environments` (once, cached) → `POST /v1/agents` → `POST /v1/sessions` |
| Click **+** on the tab strip | `POST /v1/sessions` (new session for the agent) |
| Type + **SEND** | `POST /v1/sessions/{id}/messages` → renders the returned events |

A turn returns agent text, plus any `bash` tool calls the agent made and their
results — text becomes chat bubbles; tool calls/results render as compact rows
beneath them.

### Models

The modal's three buttons map to the model strings the agent-service sends to
Anthropic (`src/lib/models.ts`):

| Button | Model id |
|---|---|
| Opus 4.8 | `claude-opus-4-8` |
| Sonnet 4.6 | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` |

### State & persistence

The REST API has no "list agents" or "list history" endpoint — `send` is the only
call that returns events — so the **frontend is the source of truth** for which
agents/sessions exist and what was said. State persists to `localStorage` and is
restored on reload.

If you reset the backend stores (`docker compose down -v`), the persisted ids go
stale and calls will 404. Click **↺ reset** in the sidebar (bottom-left) to clear
local data and start fresh.

## Scripts

```bash
npm run dev          # dev server with API proxy + HMR
npm run build        # tsc typecheck + production build to dist/
npm run typecheck    # types only
npm run preview      # serve the production build
```

## Project layout

```
src/
  api/        REST client (client.ts) + wire types (types.ts)
  lib/        models, avatar letter, localStorage, event→ChatItem mapping
  state/      useFunkyStore — reducer + async actions for the backend flow
  components/ Sidebar, SessionTabs, Conversation, ChatMessage, Composer,
              CreateAgentModal, Mascot, Avatar, TypingIndicator, …
  styles.css  the Paper skin: tokens, pixel borders, hard shadows, animations
  App.tsx     the shell
```

## Design

Recreates the **Paper** skin from the design reference (pixel borders, hard offset
shadows, no rounded corners; Press Start 2P for UI labels, VT323 for body). The
two alternate skins (Arcade, Midnight) are not implemented; the token set in
`styles.css` (`:root`) is the single place to retheme.
