# Funky

Spin up agent swarms on demand. Define an agent (system prompt + model), give it a sandboxed environment, send it work — Funky handles the durability and the infrastructure.

> **Status: early development.** You can run an agent end-to-end today — no API key required. The sandbox has no isolation yet (see the roadmap).

## Quickstart

Requires Docker. No API key needed.

```bash
git clone https://github.com/funkyhq/funky && cd funky
cp .env.example .env        # set FUNKY_AUTH_TOKEN to any long random string
docker compose up --build
```

The stack is up when the `worker` and `api` services are healthy. Then:

```bash
export TOKEN=<your FUNKY_AUTH_TOKEN>
export H="Authorization: Bearer $TOKEN"
export J="content-type: application/json"

# 1. an agent: who it is and what model it uses
AID=$(curl -s -X POST localhost:3000/v1/agents -H "$H" -H "$J" -d '{
  "name": "shell agent",
  "system_prompt": "You are a helpful engineer. Use the sandbox to run commands.",
  "model": { "provider": "anthropic", "model": "claude-sonnet-5" }
}' | jq -r .id)

# 2. an environment: where its commands run
EID=$(curl -s -X POST localhost:3000/v1/environments -H "$H" -H "$J" -d '{
  "name": "basic",
  "base_image": "funky/base:latest"
}' | jq -r .id)

# 3. a session: an agent + an environment, with a sandbox and a durable event log
SID=$(curl -s -X POST localhost:3000/v1/sessions -H "$H" -H "$J" \
  -d "{\"agent\":\"$AID\",\"environment_id\":\"$EID\"}" | jq -r .id)

# 4. watch it think (leave this running)
curl -N -H "$H" localhost:3000/v1/sessions/$SID/events/stream &

# 5. give it work
curl -s -X POST localhost:3000/v1/sessions/$SID/messages -H "$H" -H "$J" \
  -d '{"content":"say hello from the sandbox"}'
```

You'll see the agent provision a sandbox, decide to run a command, execute it, and report
back:

```
event: session_provisioned
event: assistant_message      { "tool_calls": [{ "kind": "exec", "cmd": "echo …" }] }
event: tool_result            { "output": "hello from the funky sandbox\n", "exit_code": 0 }
event: assistant_message      { "content": [{"type":"text","text":"I ran a command…"}] }
event: turn_completed
```

### Durability

Funky keeps each session's state in Postgres — the append-only event log is the source of
truth, not any worker's memory. A worker holds no session state between turns: it reads the
log, performs the single next step, and appends the result in one conditional-append
transaction. The durable record of what happened lives in the database, so a worker is a
stateless, replaceable unit.

> **Honest limit — the `subprocess` driver.** The dev sandbox runs commands **inside the
> worker container** (no isolation — see the roadmap), so the sandbox filesystem and any
> in-flight command are *not* durable: they live and die with that container. The headline
> demo — kill a worker mid-command and have a replacement **re-attach to the still-running
> command** and finish the turn — needs a sandbox that outlives the worker. That contract
> (idempotent `exec` keyed so a command never runs twice, whatever the driver) is already
> in the sandbox port and its conformance suite; the live demo lands with the persistent
> provider driver (E2B via ComputeSDK), next.

### Using a real model

```bash
# in .env
FUNKY_LLM=ai-sdk
ANTHROPIC_API_KEY=sk-ant-...
```
```bash
docker compose up -d --build worker
```
Now the same curl commands drive a real Claude, writing and running its own shell commands.

### Tear down

```bash
docker compose down       # stop and remove the containers
docker compose down -v    # ...and also delete the database volume
```

## Local development

Requires Node 22+, pnpm, and Docker (for Postgres).

```bash
pnpm install

# database
docker run -d --name funky-pg \
  -e POSTGRES_USER=funky -e POSTGRES_PASSWORD=funky -e POSTGRES_DB=funky \
  -p 5432:5432 postgres:16
pnpm -F @funky/db migrate

# run the API with hot reload
pnpm dev
```

Useful commands: `pnpm typecheck` · `pnpm -F @funky/db generate` (new migration after schema changes) · `pnpm -F @funky/db exec drizzle-kit studio` (database browser).

## Layout

```
apps/api           HTTP API (Hono): agents, environments, sessions, SSE
apps/worker        the agent runtime — pulls turns off the queue and drives the loop
packages/sessions  the event log, the reducer, the turn loop, the job queue
packages/configs   agent + environment config domain logic
packages/ports     provider-neutral ports (llm, sandbox) + their drivers
packages/db        Drizzle schema + migrations
```

`apps` are deployable processes; `packages` are libraries. Apps depend on packages, never the reverse.

## Roadmap

- [x] Agent configs (versioned, archive-only) — create/update/list/archive + version history
- [x] Environment configs (unversioned, archive or delete) — the sandbox recipe: base image, persistent fs, egress policy
- [x] Sessions & event log
- [x] Agent runtime worker (the loop)
- [x] Sandboxed execution — subprocess driver: **no isolation yet** (commands run inside the worker container); provider drivers (E2B via ComputeSDK) next
- [ ] SDKs (TypeScript, Python)

## Contributing

This is an early-stage, contracts-first project. The best contribution right now is feedback on the interfaces. Open an issue to discuss the protocol, a missing method, or a backend you'd want to plug in.

## License

[Apache 2.0](./LICENSE).
