# funky-client (python)

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

## Chat from the command line

`funky-chat` is one command that starts a conversation: it creates an agent, an
environment, and a session, then loops — read a line, run it as a turn, print what
the agent does and says.

```bash
# The agent calls Anthropic, so export your API key first:
export ANTHROPIC_API_KEY=sk-ant-...

# Bring up all four services in-process and chat — nothing else to start.
# Also needs a Docker daemon for the SandboxRuntime.
uv run funky-chat --local

# Or point at services you're already running on their default ports (8080–8083):
uv run funky-chat

# Override the model, system prompt, or any service URL:
uv run funky-chat --model claude-sonnet-4-6 --system "You are a terse shell wizard."

# Resume an existing session instead of starting fresh:
uv run funky-chat --session-id ses_...
```

`--local` starts the four backends on ephemeral ports backed by a throwaway data
directory and tears them down when you exit — handy for a quick session without
opening four terminals. It needs the backends installed (they ship as the
`funky-client[local]` extra; in this workspace they're already present). Without
`--local`, run one of each service yourself (see the backend READMEs) and the
default `--*-url` flags will find them.

```
Funky chat — session ses_1a2b…
Type a message; Ctrl-D or 'exit' to quit.

you> what python version is in the sandbox?
  · bash: python3 --version
    Python 3.12.13
agent> The sandbox has Python 3.12.13.
you> exit
```

Tool calls the agent makes are shown as `· <tool>: <command>` with the result
indented beneath; a failed command is marked `(error)`. The defaults point at the
local backends, so `funky-chat` alone is enough once they're up (the AgentService
needs `ANTHROPIC_API_KEY` and a reachable SandboxRuntime, as its README covers).
`--help` lists every flag.

## Test

```bash
uv run pytest client/python
```

The client tests drive `FunkyClient` against in-memory fakes of the four services
and assert the orchestration: the agent config is snapshotted into the session, a
turn runs against the prior history with the new prompt, the whole exchange is
persisted in order, history accumulates across turns, and the sandbox is always
torn down — even when the turn fails. The CLI tests script `input` and a fake
client to check the chat loop and how events render. Each service's own wire path
is covered by its backend's tests, so these focus on coordination and need no
servers.
