# Funky Console

A small developer console for trying out the Funky API from a browser: create an agent,
configure an environment, start a session, and chat with the agent while watching it run
commands in its sandbox. It is a thin client over the real REST API — it adds **no**
backend endpoints and stores nothing of its own.

- **Quick Start** — a 4-step wizard (agent → environment → session → first message) that
  ends in a live chat. The right-hand panel shows the equivalent, copy-pasteable `curl`.
- **Agents / Sessions / Environments** — list, create (modal), and archive, with
  multi-select bulk archive.
- **Chat** — streams the session's event log over SSE: user + agent messages, plus the
  commands the agent runs and their output.

## Running it

The console talks to the API over same-origin paths that the Vite dev server proxies to the
backend, injecting the bearer token — so the token never ships to the browser and there is
no CORS to configure (the API is left untouched). Config is read from the **monorepo root
`.env`** (the same file `docker compose` uses):

| var | meaning | default |
| --- | --- | --- |
| `FUNKY_API_URL` | where the API listens | `http://localhost:3000` |
| `FUNKY_AUTH_TOKEN` | bearer token; leave unset if the API runs `FUNKY_AUTH=disabled` | — |

```bash
# 1. bring up the backend (from the repo root) — see the top-level README Quickstart
docker compose up --build

# 2. run the console
pnpm -F web dev        # then open the printed URL (default http://localhost:5173)
```

If the backend isn't reachable, the console shows a blocking "Backend API not reachable"
gate with the commands to start it, and recovers automatically once `/healthz` is green.

## How it maps to the API

The UI is intentionally simpler than the API; a few fields are filled in for you:

- **Model** — the dropdown labels map to the API's `{ provider, model }` shape
  (`src/lib/models.ts`). With the default zero-key `fake` LLM any choice works; with
  `FUNKY_LLM=ai-sdk` + `ANTHROPIC_API_KEY`, pick the Claude option.
- **Environment** — the create form asks only for name + description. There is no image
  to pick: the sandbox runtime is the backend's concern (the dev driver runs commands in
  the worker container), so the environment is just identity + egress policy.
- **Chat** — messages are `POST`ed to `/v1/sessions/:id/messages`; replies (and the
  agent's sandbox activity) arrive on `GET /v1/sessions/:id/events/stream`, which the
  event log makes durable and replayable.

## Scripts

`pnpm -F web dev` · `pnpm -F web build` · `pnpm -F web lint` · `pnpm -F web preview`

## Layout

```
src/lib        API client, wire types, model mapping, formatting helpers
src/ui         design-system primitives (Button, Input, Badge, Modal, CodeBlock, …)
src/console    screens (QuickStart, Agents, Sessions, Environments, Chat) + shared parts
src/theme.css  brand tokens
```
