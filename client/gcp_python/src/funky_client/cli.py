"""funky-chat: one command to talk to a Funky agent from the terminal.

A small REPL over a ``FunkyClient``. It creates an agent, an environment, and a
session (or resumes one with ``--session-id``), then loops: read a line, run it as
one turn, print what the agent does and says. Each turn's tool calls run in a
sandbox via the services the client points at, so the four services must be up
(see the client README); the CLI itself only needs their URLs.
"""

from __future__ import annotations

import argparse
import sys

from connectrpc.errors import ConnectError
from google.protobuf import json_format

from funky.type.v1 import agent_pb2, event_pb2

from .client import FunkyClient

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_SYSTEM = (
    "You are a helpful assistant working in a sandbox. "
    "Use the bash tool to run commands when it helps."
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start a chat with a Funky agent from the command line."
    )
    parser.add_argument("--config-registry-url", default="http://127.0.0.1:8080")
    parser.add_argument("--session-store-url", default="http://127.0.0.1:8081")
    parser.add_argument("--sandbox-runtime-url", default="http://127.0.0.1:8082")
    parser.add_argument("--agent-service-url", default="http://127.0.0.1:8083")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="model the agent runs on")
    parser.add_argument("--system", default=DEFAULT_SYSTEM, help="agent system prompt")
    parser.add_argument("--name", default="cli", help="agent name (display only)")
    parser.add_argument(
        "--session-id",
        help="resume this session instead of creating a fresh agent/env/session",
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="also start the four services in-process (needs Docker + "
        "ANTHROPIC_API_KEY); ignores the --*-url flags",
    )
    args = parser.parse_args()

    if args.local:
        urls = _serve_local()
    else:
        urls = {
            "config_registry_url": args.config_registry_url,
            "session_store_url": args.session_store_url,
            "sandbox_runtime_url": args.sandbox_runtime_url,
            "agent_service_url": args.agent_service_url,
        }

    client = FunkyClient.from_urls(**urls)

    try:
        session_id = args.session_id or _start_session(client, args)
    except ConnectError as err:
        print(f"could not reach a service: {err}", file=sys.stderr)
        return 1

    print(f"Funky chat — session {session_id}")
    print("Type a message; Ctrl-D or 'exit' to quit.\n")
    _chat(client, session_id)
    return 0


def _serve_local() -> dict[str, str]:
    """Boot the four backends in-process on ephemeral ports; return their URLs.

    Lets ``--local`` bring up the whole stack from one command. It needs the
    service backends installed (``funky-client[local]``), a Docker daemon for the
    SandboxRuntime, and ANTHROPIC_API_KEY for the AgentService — the same
    requirements as starting the four servers by hand. The servers run in daemon
    threads on a throwaway data dir, so they shut down when the chat exits.
    """
    try:
        from waitress.server import create_server

        from funky.agent.v1.agent_service_connect import AgentServiceWSGIApplication
        from funky.registry.v1.config_registry_connect import (
            ConfigRegistryWSGIApplication,
        )
        from funky.sandbox.v1.sandbox_runtime_connect import (
            SandboxRuntimeClientSync,
            SandboxRuntimeWSGIApplication,
        )
        from funky.session.v1.session_store_connect import SessionStoreWSGIApplication
        from funky_agent_service_anthropic.service import AgentServiceAnthropic
        from funky_config_registry_jsonl.service import ConfigRegistryService
        from funky_sandbox_runtime_docker.service import SandboxRuntimeService
        from funky_session_store_jsonl.service import SessionStoreService
    except ImportError as err:
        raise SystemExit(
            f"--local needs the service backends (missing {err.name!r}); "
            "install them with: pip install 'funky-client[local]'"
        )

    import tempfile
    import threading
    from pathlib import Path

    data_dir = Path(tempfile.mkdtemp(prefix="funky-chat-"))

    def serve(app) -> str:
        server = create_server(app, host="127.0.0.1", port=0)
        threading.Thread(target=server.run, daemon=True).start()
        return f"http://127.0.0.1:{server.socket.getsockname()[1]}"

    config_registry_url = serve(
        ConfigRegistryWSGIApplication(ConfigRegistryService(data_dir / "config"))
    )
    session_store_url = serve(
        SessionStoreWSGIApplication(SessionStoreService(data_dir / "sessions"))
    )
    try:
        # SandboxRuntimeService() connects to the Docker daemon up front.
        sandbox_runtime_url = serve(
            SandboxRuntimeWSGIApplication(SandboxRuntimeService())
        )
    except Exception as err:
        raise SystemExit(
            f"--local could not start the SandboxRuntime (is Docker running?): {err}"
        )
    try:
        # The AgentService execs its tools in the local SandboxRuntime above.
        agent = AgentServiceAnthropic(SandboxRuntimeClientSync(sandbox_runtime_url))
    except Exception as err:
        raise SystemExit(
            f"--local could not start the AgentService (is ANTHROPIC_API_KEY set?): {err}"
        )
    agent_service_url = serve(AgentServiceWSGIApplication(agent))

    print(f"Started local services (data in {data_dir}):")
    print(f"  config registry  {config_registry_url}")
    print(f"  session store    {session_store_url}")
    print(f"  sandbox runtime  {sandbox_runtime_url}")
    print(f"  agent service    {agent_service_url}\n")
    return {
        "config_registry_url": config_registry_url,
        "session_store_url": session_store_url,
        "sandbox_runtime_url": sandbox_runtime_url,
        "agent_service_url": agent_service_url,
    }


def _start_session(client: FunkyClient, args: argparse.Namespace) -> str:
    """Create an agent, an environment, and a session; return the session id."""
    agent_id = client.agents.create(
        agent_pb2.AgentConfig(
            name=args.name, model=args.model, system_prompt=args.system
        )
    )
    environment_id = client.environments.create()
    return client.sessions.create(agent_id, environment_id)


def _chat(client: FunkyClient, session_id: str) -> None:
    """Read–run–print loop until EOF, Ctrl-C, or 'exit'/'quit'."""
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        if line in {"exit", "quit"}:
            return
        try:
            events = client.sessions.send(session_id, line)
        except KeyboardInterrupt:
            print("\n  [interrupted]")
            continue
        except ConnectError as err:
            print(f"  [error] {err}", file=sys.stderr)
            continue
        for event in events:
            _render(event)


def _render(event: event_pb2.Event) -> None:
    """Print one event the agent produced: its text, or a tool call/result."""
    kind = event.WhichOneof("payload")
    if kind == "agent_message":
        text = _text(event.agent_message.content)
        if text:
            print(f"agent> {text}")
    elif kind == "agent_tool_use":
        args = json_format.MessageToDict(event.agent_tool_use.input)
        detail = args.get("command", args)
        print(f"  · {event.agent_tool_use.name}: {detail}")
    elif kind == "agent_tool_result":
        text = _truncate(_text(event.agent_tool_result.content).strip())
        flag = " (error)" if event.agent_tool_result.is_error else ""
        if text or flag:
            print(f"    {text}{flag}")


def _text(blocks) -> str:
    return "".join(
        block.text.text for block in blocks if block.WhichOneof("block") == "text"
    )


def _truncate(text: str, limit: int = 500) -> str:
    return text if len(text) <= limit else text[:limit] + " …"


if __name__ == "__main__":
    raise SystemExit(main())
