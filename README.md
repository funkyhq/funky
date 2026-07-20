<img width="2103" height="748" alt="funky_github" src="https://github.com/user-attachments/assets/3433c331-58d6-48bd-aa05-8d605d8fc8ce" />

# Funky

The durable runtime for agent swarms.

Define an agent, give it a sandboxed environment, send it work. Funky handles the durability and the infrastructure.

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
  "name": "Funky Assistant",
  "system_prompt": "You are an autonomous research and coding agent.",
  "model": { "provider": "anthropic", "model": "claude-sonnet-5" }
}' | jq -r .id)

# 2. an environment: where its commands run
EID=$(curl -s -X POST localhost:3000/v1/environments -H "$H" -H "$J" -d '{
  "name": "basic",
  "network": { "type": "unrestricted" }
}' | jq -r .id)

# 3. a session: an agent + an environment, with a sandbox and a durable event log
SID=$(curl -s -X POST localhost:3000/v1/sessions -H "$H" -H "$J" \
  -d "{\"agent\":\"$AID\",\"environment_id\":\"$EID\"}" | jq -r .id)

# 4. watch it think (leave this running)
curl -N -H "$H" localhost:3000/v1/sessions/$SID/events/stream &

# 5. give it work
curl -s -X POST localhost:3000/v1/sessions/$SID/messages -H "$H" -H "$J" \
  -d '{"content":"What is the top 3 trending project on Github?"}'
```

You'll see the agent provision a sandbox, decide to run a command, execute it, and report
back:

```
event: session_provisioned
event: assistant_message      { "tool_calls": [{ "kind": "exec", "cmd": "curl -s https://github.com/trending …" }] }
event: tool_result            { "output": "…", "exit_code": 0 }
event: assistant_message      { "content": [{"type":"text","text":"The top 3 trending projects are…"}] }
event: turn_completed
```

> **Prefer a UI?** The `curl` flow above is also a few clicks in the **Funky Console** — the
> browser dev console that ships with the stack. `docker compose up` serves it at
> http://localhost:5173: create an agent, environment, and session, then chat with the agent
> and watch it run commands in its sandbox — with the equivalent `curl` shown alongside. It's
> a thin client over the same REST API (see [`apps/web`](apps/web)).

<img width="1462" height="753" alt="Screenshot 2026-07-16 at 10 22 12 AM" src="https://github.com/user-attachments/assets/46dd31b9-0388-46bf-a12d-f28abdb6a263" />

### Using a real model (e.g. sonnet-5)

```bash
# in .env
FUNKY_LLM=ai-sdk
ANTHROPIC_API_KEY=sk-ant-...
```
```bash
docker compose up -d --build worker
```
Now the same curl commands drive a real Claude, writing and running its own shell commands.

### Using a remote sandbox (e.g. E2B)

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
driver.

### Running an agent on the Claude Code harness

Agents can run their turns inside [Claude Code](https://code.claude.com/docs/en/agent-sdk)
(the Agent SDK) instead of Funky's native loop — same sessions, same sandboxes, same
durable event log. This is a self-contained walkthrough; no need to run the Quickstart first.

**1. Add your key to `.env`** (independent of `FUNKY_LLM`) and bring up the stack:

```bash
# .env
FUNKY_AUTH_TOKEN=<any long random string>
ANTHROPIC_API_KEY=sk-ant-...
```
```bash
docker compose up --build -d
# already running from the Quickstart? pick up the new key with: docker compose up -d --build worker
```

The stack is ready when the `worker` and `api` services report healthy (`docker compose ps`).

**2. Create a harness agent, an environment, a session, and send it work.** The only
difference from a native agent is the `"runtime"` field on the agent:

```bash
export TOKEN=<your FUNKY_AUTH_TOKEN>
export H="Authorization: Bearer $TOKEN"
export J="content-type: application/json"

# an agent that runs its turns on the Claude Code harness (requires an anthropic model)
AID=$(curl -s -X POST localhost:3000/v1/agents -H "$H" -H "$J" -d '{
  "name": "Claude Code Agent",
  "system_prompt": "You are an autonomous research and coding agent.",
  "model":   { "provider": "anthropic", "model": "claude-sonnet-5" },
  "runtime": { "type": "claude-code" }
}' | jq -r .id)

# an environment, then a session on it
EID=$(curl -s -X POST localhost:3000/v1/environments -H "$H" -H "$J" \
  -d '{"name":"basic","network":{"type":"unrestricted"}}' | jq -r .id)
SID=$(curl -s -X POST localhost:3000/v1/sessions -H "$H" -H "$J" \
  -d "{\"agent\":\"$AID\",\"environment_id\":\"$EID\"}" | jq -r .id)

# watch it think (leave running), then give it work
curl -N -H "$H" localhost:3000/v1/sessions/$SID/events/stream &
curl -s -X POST localhost:3000/v1/sessions/$SID/messages -H "$H" -H "$J" \
  -d '{"content":"create a file hello.txt containing hi, then read it back to me"}'
```

You'll see a `harness_attempt_started` event, then the agent run commands in its sandbox
(`assistant_message` → `tool_result`) and answer — the same event stream as a native turn.

> The **Console** at http://localhost:5173 can *view* a harness session, but can't yet
> *create* one — use the `curl` above to create the agent with `runtime`.

The harness's commands execute in the session's Funky sandbox (exactly-once, crash-safe),
and the Claude Code transcript is stored in Funky's Postgres — so a session survives worker
crashes and can be resumed by any worker, keeping turns fully stateless. Design and
guarantees: [`packages/ports/harness/DESIGN.md`](packages/ports/harness/DESIGN.md).

### Tear down

```bash
docker compose down       # stop and remove the containers
docker compose down -v    # ...and also delete the database volume
```

## Why Funky?

Most runtimes put the agent *inside* the sandbox: its reasoning loop, memory, and state all
live in one box. When that box goes down, the agent and its in-flight work go with it. Funky
decouples the agent from the box it runs in.

Agents don't die when the server goes down. Funky records every session as an append-only
event log, then safely resumes interrupted work when the runtime comes back online: a fresh,
stateless worker replays the log and re-attaches to the still-running sandbox command, with
nothing lost and nothing run twice. Run one agent or a multi-agent swarm on the same durable
foundation.

## Architecture Diagram
<img src="architecture_diagram.svg" alt="Architecture diagram" width="700">

## Contributing

This is an early-stage project. The best contribution right now is feedback on the interfaces. Open an issue to discuss the protocol, a missing method, or a backend you'd want to plug in.

## License

[Apache 2.0](./LICENSE).
