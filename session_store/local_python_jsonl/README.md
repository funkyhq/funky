# local_python_jsonl

A fully local [`SessionStore`](../../proto/funky/session/v1/session_store.proto)
that stores sessions and their event history in two append-only JSONL files — no
database, no cloud.

- `sessions.jsonl` — one line per session
- `events.jsonl` — one line per appended event, in append order

Each line is the proto3 JSON form of the message itself. `CreateSession`
snapshots the resolved agent config into a new session, mints a `ses_` id, and
returns it; `GetSession` resolves an id back to the session. `AppendEvent`
appends an event to a session — the store assigns the event's `evt_` id, its
`session_id`, and a `processed_at` timestamp on the stored copy, preserving the
caller's payload; `ListEvents` reads a session's events back in append order.

## Run it

From the repository root:

```bash
buf generate            # regenerate the protobuf/ConnectRPC stubs into gen/python
uv sync                 # create the workspace venv and install the backend + deps
uv run funky-session-store-jsonl --data-dir ./data --port 8081
```

The server runs on [waitress](https://github.com/Pylons/waitress) (pure Python,
fully local) and speaks ConnectRPC over HTTP/1.1 + JSON, so you can poke it with
`curl` (note proto3 JSON uses camelCase field names, e.g. `agentConfig`,
`environmentConfigId`, `sessionId`, `userMessage`):

```bash
# Create a session -> {"session":{"id":"ses_...", ...}}
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/CreateSession \
  -H 'Content-Type: application/json' \
  -d '{"agentConfig":{"name":"researcher","model":"gemini-3.5-flash","systemPrompt":"You are a careful research assistant."},"environmentConfigId":"env_local"}'

# Resolve it back
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/GetSession \
  -H 'Content-Type: application/json' \
  -d '{"id":"ses_..."}'

# Append a user-message event -> the stored event, with id and processedAt set
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/AppendEvent \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"ses_...","event":{"userMessage":{"content":[{"text":{"text":"hello"}}]}}}'

# Read the session's history, in append order
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/ListEvents \
  -H 'Content-Type: application/json' -d '{"sessionId":"ses_..."}'
```

The written files are human-readable:

```bash
cat data/sessions.jsonl data/events.jsonl
```

## Test

```bash
uv run pytest session_store/local_python_jsonl
```

The test boots the server on an ephemeral port and drives it through the
generated ConnectRPC client, covering the session round trip, appending and
listing events (in order, scoped per session), and the NOT_FOUND paths.
