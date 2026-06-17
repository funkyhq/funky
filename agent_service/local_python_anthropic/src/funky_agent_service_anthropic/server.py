"""Serve the Anthropic AgentService as a local ConnectRPC server.

Mirrors the other backends' servers: the generated WSGI application on waitress, a
pure-Python WSGI server. (The stdlib ``wsgiref`` server is not used: it hands the
app the raw, unbounded socket as ``wsgi.input``, which deadlocks connect-python's
error path when it drains the request body.) RunTurn is a unary RPC, so it speaks
ConnectRPC over HTTP/1.1 + JSON and is reachable with plain ``curl`` (see
README.md).

The agent calls the Anthropic Messages API, so ANTHROPIC_API_KEY must be set in
the environment, and it execs its tools in a SandboxRuntime, so one must be
reachable at --sandbox-runtime-url (the local Docker backend's default port). The
server itself is fully local.
"""

from __future__ import annotations

import argparse

from waitress.server import create_server

from funky.agent.v1.agent_service_connect import AgentServiceWSGIApplication
from funky.sandbox.v1.sandbox_runtime_connect import SandboxRuntimeClientSync

from .loop import DEFAULT_MAX_TOKENS
from .service import AgentServiceAnthropic


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    # Off the ConfigRegistry's 8080, SessionStore's 8081, and SandboxRuntime's
    # 8082 so every backend can run locally at once.
    parser.add_argument("--port", type=int, default=8083)
    parser.add_argument(
        "--sandbox-runtime-url",
        default="http://127.0.0.1:8082",
        help="base URL of the SandboxRuntime the agent execs its tools in",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help="cap on the tokens the model may produce per turn",
    )
    args = parser.parse_args()

    sandbox_client = SandboxRuntimeClientSync(args.sandbox_runtime_url)
    service = AgentServiceAnthropic(sandbox_client, max_tokens=args.max_tokens)
    app = AgentServiceWSGIApplication(service)

    server = create_server(app, host=args.host, port=args.port)
    host, port = server.socket.getsockname()[:2]
    print(
        f"AgentService (anthropic) listening on http://{host}:{port}\n"
        f"  sandbox runtime: {args.sandbox_runtime_url}\n"
        f"  max_tokens: {args.max_tokens}",
        flush=True,
    )
    server.run()


if __name__ == "__main__":
    main()
