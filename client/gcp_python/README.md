# funky-client (gcp_python)

The thin **Client** from the [architecture](../../docs/architecture.mmd) — the
orchestrator developers actually call. It wires the four Funky services together
over their generated ConnectRPC clients and resolves ids to configs so you never
touch the services directly. It has no server and no backend of its own; point it
at one of each service and go.

```
ConfigRegistry   SessionStore   SandboxRuntime   AgentService
       \              |               |              /
        \             |               |             /
                      FunkyClient (this)
```

## The API

Four calls, mirroring the architecture diagram:

| Call | Does |
|---|---|
| `client.agents.create(agent_config)` → `agent_id` | store an agent spec in the ConfigRegistry |
| `client.environments.create(env_config=None)` → `environment_id` | store an environment spec (empty config is fine) |
| `client.sessions.create(agent_id, environment_id)` → `session_id` | resolve the agent and open a session for it |
| `client.sessions.send(session_id, prompt)` → `events` | run one agent turn and return the agent's events |

`sessions.send` is where the coordination happens. For one prompt it: resolves
the session and its environment config, reads the prior history and persists the
new user message, provisions a sandbox from the session's agent + environment,
runs the turn against the history through the `AgentService`, persists every event
the agent produces, and tears the sandbox down afterwards (even if the turn
fails). The agent config is **snapshotted into the session** at `create`, so the
turn runs the agent as it was then, regardless of later registry edits.

## Use it

```python
from funky_client import FunkyClient
from funky.type.v1 import agent_pb2

client = FunkyClient.from_urls(
    config_registry_url="http://127.0.0.1:8080",
    session_store_url="http://127.0.0.1:8081",
    sandbox_runtime_url="http://127.0.0.1:8082",
    agent_service_url="http://127.0.0.1:8083",
)

agent_id = client.agents.create(
    agent_pb2.AgentConfig(
        name="coder",
        model="claude-sonnet-4-6",
        system_prompt="You are a careful coding assistant.",
    )
)
environment_id = client.environments.create()
session_id = client.sessions.create(agent_id, environment_id)

for event in client.sessions.send(session_id, "Use bash to print the Python version."):
    if event.HasField("agent_message"):
        print(event.agent_message.content[0].text.text)
```

This assumes one of each service is running on the ports above — see each
backend's README ([ConfigRegistry](../../config_registry/local_python_jsonl),
[SessionStore](../../session_store/local_python_jsonl),
[SandboxRuntime](../../sandbox_runtime/local_python_docker),
[AgentService](../../agent_service/local_python_anthropic)). The constructor also
takes the four clients directly (`FunkyClient(registry, store, runtime, agent)`),
which is how the tests inject fakes.

## Run as an HTTP service

`funky-client-server` wraps the same `FunkyClient` in a small JSON/REST + SSE HTTP
service, so the orchestrator can run as its own process (e.g. a fifth Cloud Run
service): callers hit **one** endpoint instead of wiring up four. It's stateless —
every request resolves ids against the backends — so it scales to zero and back.

The four backend URLs come from the environment, each falling back to the local
default port, so it runs locally with nothing set:

```bash
# Point it at the four services (omit any that are on their local default port).
export CONFIG_REGISTRY_URL=https://config-registry-xxxx.run.app
export SESSION_STORE_URL=https://session-store-xxxx.run.app
export SANDBOX_RUNTIME_URL=https://sandbox-runtime-xxxx.run.app
export AGENT_SERVICE_URL=https://agent-service-xxxx.run.app

uv run --extra server funky-client-server --port 8000
```

The endpoints mirror the four client calls (JSON in, JSON out, snake_case):

| Method & path | Body | Returns |
|---|---|---|
| `GET /health` | — | `{"status":"ok"}` (not `/healthz` — Google's frontend reserves that path) |
| `POST /v1/agents` | `{"name","model","system_prompt"}` | `{"id":"agt_…"}` |
| `POST /v1/environments` | `{}` (optional) | `{"id":"env_…"}` |
| `POST /v1/sessions` | `{"agent_id","environment_id"}` | `{"id":"ses_…"}` |
| `POST /v1/sessions/{id}/messages` | `{"prompt":"…"}` | `{"events":[…]}` |

```bash
AGENT=$(curl -sX POST localhost:8000/v1/agents \
  -d '{"name":"coder","model":"claude-sonnet-4-6","system_prompt":"Be brief."}' | jq -r .id)
ENV=$(curl -sX POST localhost:8000/v1/environments -d '{}' | jq -r .id)
SES=$(curl -sX POST localhost:8000/v1/sessions \
  -d "{\"agent_id\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jq -r .id)

# One turn, all events at once:
curl -sX POST localhost:8000/v1/sessions/$SES/messages -d '{"prompt":"print the python version"}'

# Or as Server-Sent Events — one frame per event, then a final `done`:
curl -NsX POST localhost:8000/v1/sessions/$SES/messages \
  -H 'accept: text/event-stream' -d '{"prompt":"print the python version"}'
```

> **On SSE today:** the `AgentService`'s `RunTurn` is *unary* — it returns the whole
> turn at once — so the SSE frames flush together when the turn completes rather
> than incrementally. The wire contract is the live-streaming one already: when
> `RunTurn` becomes server-streaming, the same endpoint streams events mid-turn
> with no change for SSE clients. Auth is **not** handled yet (see the top-level
> note); deploy the backends `--allow-unauthenticated` for now.

## Deploy to Cloud Run

The [`Dockerfile`](./Dockerfile) builds a self-contained image — it runs
`buf generate` and installs this client with its `server` extra from the committed
lockfile, then serves on `$PORT` bound to all interfaces (Cloud Run's contract).

> **The build context must be the repository root, not this directory** (same as
> the other backends): the client resolves `funky-protos` from the uv workspace
> and `buf generate` reads `buf.gen.yaml`, `buf.yaml`, and `proto/`, all at the
> repo root.

**Cloud Build / Cloud Run trigger** — [`cloudbuild.yaml`](./cloudbuild.yaml) is the
trigger config (build → push → deploy) with the repo-root build context. Run it by
hand from the repository root:

```bash
gcloud builds submit \
  --config client/gcp_python/cloudbuild.yaml \
  --substitutions=REPO_NAME=funky,COMMIT_SHA=manual
```

**Or build locally** and push (Cloud Run is linux/amd64):

```bash
# From the repository root.
IMAGE="REGION-docker.pkg.dev/PROJECT/REPO/funky-client"
docker build -f client/gcp_python/Dockerfile --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

Then deploy, pointing it at the four service URLs:

```bash
gcloud run deploy funky-client \
  --image "$IMAGE" --region REGION \
  --set-env-vars CONFIG_REGISTRY_URL=https://config-registry-xxxx.run.app,\
SESSION_STORE_URL=https://session-store-xxxx.run.app,\
SANDBOX_RUNTIME_URL=https://sandbox-runtime-xxxx.run.app,\
AGENT_SERVICE_URL=https://agent-service-xxxx.run.app
```

A turn runs the model and tool calls synchronously, so it can be slow; bump
`--timeout` (Cloud Run's request timeout, default 300s) if your turns run long.

## Test

```bash
uv run pytest client/gcp_python
```

The client tests drive `FunkyClient` against in-memory fakes of the four services
and assert the orchestration: the agent config is snapshotted into the session, a
turn runs against the prior history with the new prompt, the whole exchange is
persisted in order, history accumulates across turns, and the sandbox is always
torn down — even when the turn fails. The server tests drive the HTTP surface
(over the same fakes) through Starlette's test client: the four
endpoints round-trip ids, a turn returns the agent's events as JSON and as SSE
frames, and bad input / backend errors map to the right status. Each service's own
wire path is covered by its backend's tests, so these focus on coordination and
need no servers.
