# local_python_anthropic

A fully local [`AgentService`](../../proto/funky/agent/v1/agent_service.proto)
that runs one agent turn against the [Anthropic](https://docs.anthropic.com/)
Messages API — no agent platform, no managed loop, just a direct call to the
model from your machine.

`RunTurn` takes the agent, the conversation so far, and a new prompt; converts
the prior events plus the prompt into Anthropic messages (with the agent's `model`
and `system_prompt`); calls the Messages API; and returns the reply as one
`AgentMessage` event per text block the model produces. It is unary — one request,
one response holding all of the turn's events.

The turn is stateless, exactly as the contract requires — the prior events are
passed in, never stored — and the events it emits are payload-only: the
`SessionStore` assigns their id, session_id, and processed_at when the Client
appends them to history.

## Text-only, for now

This turn is text in, text out. It accepts the `Sandbox` from the request but
does not yet run anything in it. The `Event` proto now has the `AgentToolUse` and
`AgentToolResult` events that tool calls need, but the loop doesn't emit them —
it has no tools and never reaches the sandbox. Once tool use is wired — the
`AgentService ..> SandboxRuntime : exec` edge from the architecture — this is
where the agent gains a tool, runs commands in the sandbox through a
`SandboxRuntime` client, and emits an `AgentToolUse` followed by its
`AgentToolResult`. The sandbox is accepted today so this stays that seam (the
same way the Docker runtime accepts an agent whose skills it can't load yet).

## Requirements

An Anthropic API key. The default client reads `ANTHROPIC_API_KEY` from the
environment; the model named in each request's `AgentConfig.model` must be one
your key can call. Everything else runs locally.

## Run it

From the repository root:

```bash
buf generate            # regenerate the protobuf/ConnectRPC stubs into gen/python
uv sync                 # create the workspace venv and install the backend + deps
export ANTHROPIC_API_KEY=sk-ant-...
uv run funky-agent-service-anthropic --port 8083
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
        "agentConfig": {"name":"researcher","model":"claude-sonnet-4-6","systemPrompt":"You are a careful research assistant."},
        "prompt": {"content":[{"text":{"text":"In one sentence, what is a protobuf?"}}]},
        "sandbox": {"id":"sbx_unused"}
      }'
# -> {"events":[{"agentMessage":{"content":[{"text":{"text":"..."}}]}}]}
```

## Test

```bash
uv run pytest agent_service/local_python_anthropic
```

The test boots the server on an ephemeral port and drives `RunTurn` through the
generated ConnectRPC client, covering the response holding every event the turn
produced, the payload-only invariant on those events, the history → Anthropic
messages translation (model, system prompt, role order, prompt appended last), and
the empty-system-prompt-omitted case. A fake Anthropic client stands in for the
model, so it needs no API key and makes no network calls.
