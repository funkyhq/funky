# Funky

Spin up agent swarms on demand. Define an agent (system prompt + model), give it a sandboxed environment, send it work — Funky handles the durability and the infrastructure.

> **Status: early development.** You can run an agent end-to-end today — no API key required. The default dev sandbox has no isolation; add an E2B key for isolated per-session cloud sandboxes (see "Using a real sandbox").

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

This is not a design aspiration — it is a **tested property, proven by
[`tests/chaos`](tests/chaos)**. That suite crashes a worker at every append boundary, hands
one job to two workers at once, and races a slow worker against lease expiry — asserting each
time that the event log is byte-for-byte identical, that every command ran **exactly once**,
and that the turn still ends in a terminal event. It is required on `main`: a red chaos run
blocks the release.

> **Honest limit — the default `subprocess` driver.** The dev sandbox runs commands
> **inside the worker container** (no isolation), so the sandbox filesystem and any
> in-flight command are *not* durable: they live and die with that container. The E2B
> driver (next section) removes this limit: the sandbox outlives any single worker, a
> running command records its output and exit code inside the sandbox itself, and the
> idempotent `exec` contract (a command never runs twice, whatever the driver) lets a
> replacement worker re-attach to work a dead worker started and finish the turn.

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

### Using a real sandbox

```bash
# in .env
FUNKY_SANDBOX=e2b
E2B_API_KEY=e2b_...         # from https://e2b.dev
```
```bash
docker compose up -d --build worker
```
Now every session provisions an isolated [E2B](https://e2b.dev) sandbox, through
[ComputeSDK](https://computesdk.com) so further providers can slot in behind the same
driver. The sandbox — not the worker — holds each command's output and exit code, which is
what makes sessions survive worker death: a replacement worker re-attaches by idempotency
key and reads the same files. Idle sandboxes pause after 30 minutes
(`FUNKY_E2B_SANDBOX_TIMEOUT_MS`) and resume on the next command, filesystem intact.

The E2B driver answers to the identical conformance suite as the subprocess driver; it
runs against real sandboxes when a key is present:
```bash
E2B_API_KEY=e2b_... pnpm -F @funky/sandbox test
```

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

## Contributing

This is an early-stage, contracts-first project. The best contribution right now is feedback on the interfaces. Open an issue to discuss the protocol, a missing method, or a backend you'd want to plug in.

## License

[Apache 2.0](./LICENSE).
