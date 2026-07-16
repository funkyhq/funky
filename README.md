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

<img width="1303" height="755" alt="Screenshot 2026-07-16 at 9 30 32 AM" src="https://github.com/user-attachments/assets/612e7f37-2559-41cd-bb1d-b899d212a4c2" />

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

## Contributing

This is an early-stage project. The best contribution right now is feedback on the interfaces. Open an issue to discuss the protocol, a missing method, or a backend you'd want to plug in.

## License

[Apache 2.0](./LICENSE).
