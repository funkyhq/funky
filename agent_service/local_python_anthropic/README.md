# local_python_anthropic

A fully local [`AgentService`](../../proto/funky/agent/v1/agent_service.proto)
that runs one agent turn against the [Anthropic](https://docs.anthropic.com/)
Messages API — no agent platform, no managed loop, just a direct call to the
model from your machine.

`RunTurn` takes the agent, the conversation so far, and a new prompt, and runs one
turn of an agentic loop: it converts the prior events plus the prompt into
Anthropic messages (with the agent's `model` and `system_prompt`), gives the model
a `bash` tool, and calls the Messages API. Every command the model runs is
executed in the request's `Sandbox` and fed back, looping until the model stops
calling tools. It is unary — one request, one response holding all of the turn's
events: an `AgentMessage` per text block, and an `AgentToolUse` + `AgentToolResult`
pair per command.

The turn is stateless, exactly as the contract requires — the prior events are
passed in, never stored — and the events it emits are payload-only: the
`SessionStore` assigns their Event id, session_id, and processed_at when the
Client appends them to history. (A result is matched to its call by the call's own
`AgentToolUse.id`, which the loop sets — distinct from the Event id.)

## Tools: running in the sandbox

The agent gets one tool, `bash`: run a shell command in the sandbox. When the
model calls it, the loop execs `bash -c <command>` in the request's sandbox
through a `SandboxRuntime` client (`--sandbox-runtime-url`), packages the combined
stdout/stderr as an `AgentToolResult` (`is_error` set on a non-zero exit or a
failed exec), and feeds it back to the model — this is the
`AgentService ..> SandboxRuntime : exec` edge from the architecture. The loop caps
the number of tool rounds per turn so a model can't loop forever. The sandbox
image must have `bash`; the Docker runtime's default `python:3.12-slim` does.

## Requirements

- An Anthropic API key. The default client reads `ANTHROPIC_API_KEY` from the
  environment; the model named in each request's `AgentConfig.model` must be one
  your key can call.
- A reachable [`SandboxRuntime`](../../proto/funky/sandbox/v1/sandbox_runtime.proto)
  for the agent to exec its tools in. Point at it with `--sandbox-runtime-url`,
  which defaults to the [local Docker backend](../../sandbox_runtime/local_python_docker)'s
  `http://127.0.0.1:8082`.

Otherwise everything runs locally.

## Run it

From the repository root:

```bash
buf generate            # regenerate the protobuf/ConnectRPC stubs into gen/python
uv sync                 # create the workspace venv and install the backend + deps
export ANTHROPIC_API_KEY=sk-ant-...

# In one shell: a SandboxRuntime for the agent to exec tools in.
uv run funky-sandbox-runtime-docker --port 8082

# In another: the AgentService, pointed at it.
uv run funky-agent-service-anthropic --port 8083 --sandbox-runtime-url http://127.0.0.1:8082
```

The server runs on [waitress](https://github.com/Pylons/waitress) (pure Python)
and speaks ConnectRPC over HTTP/1.1 + JSON. `RunTurn` is unary, so it is a plain
JSON POST — no special content type, no framing — and is reachable with `curl`. It
returns one JSON object whose `events` array holds the whole turn (note proto3
JSON uses camelCase field names, e.g. `agentConfig`, `systemPrompt`). Each call
makes a real, billed request to Anthropic:

```bash
curl -X POST http://127.0.0.1:8083/funky.agent.v1.AgentService/RunTurn \
  -H 'Content-Type: application/json' \
  -d '{
        "agentConfig": {"name":"coder","model":"claude-sonnet-4-6","systemPrompt":"You are a careful coding assistant."},
        "prompt": {"content":[{"text":{"text":"Use bash to print the Python version, then tell me what it is."}}]},
        "sandbox": {"id":"sbx_..."}
      }'
# -> {"events":[{"agentToolUse":{...}},{"agentToolResult":{...}},{"agentMessage":{...}}]}
```

The `sandbox.id` must be a live sandbox from the same `SandboxRuntime` — create one
first with its `CreateSandbox` (see that backend's README). A prompt the agent can
answer without a tool never touches the sandbox.

## Test

```bash
uv run pytest agent_service/local_python_anthropic
```

The test boots the server on an ephemeral port and drives `RunTurn` through the
generated ConnectRPC client, covering a text-only turn, a tool-use turn (the bash
command reaching the sandbox with the right argv, the `AgentToolUse`/
`AgentToolResult` events, and the result fed back to the model), a failed command
flagged with `is_error`, prior tool events round-tripping back into a valid
Anthropic exchange, the history translation, and the empty-system-prompt case. A
fake Anthropic client and a fake SandboxRuntime stand in for the model and the
sandbox, so it needs no API key, no Docker, and no network.
