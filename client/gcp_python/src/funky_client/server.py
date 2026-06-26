"""funky-client-server: an HTTP front door for the FunkyClient orchestrator.

The :class:`~funky_client.client.FunkyClient` is a library that fans out to the
four Funky services. This wraps it in a small JSON/REST + SSE HTTP service so it
can run as its own Cloud Run service: callers hit one endpoint instead of wiring
up four. It is stateless — every request resolves ids against the backends — so
Cloud Run can scale it to zero and back.

The four backend URLs come from the environment (``CONFIG_REGISTRY_URL``,
``SESSION_STORE_URL``, ``SANDBOX_RUNTIME_URL``, ``AGENT_SERVICE_URL``), which is
how a Cloud Run deploy points it at the other services; each falls back to the
local default port so it runs locally with no config. When those URLs are https
(Cloud Run), the client calls each backend with a Google OIDC ID token, so the
backends can be deployed private — ``--no-allow-unauthenticated`` with only this
service's account granted ``roles/run.invoker``; local http backends are called
without auth (see :func:`funky_client.client._id_token_auth`).

Endpoints (JSON in, JSON out, snake_case throughout):

    GET  /health                           -> {"status": "ok"}
    POST /v1/agents                        -> {"id": "agt_..."}
    POST /v1/environments                  -> {"id": "env_..."}
    POST /v1/sessions                      -> {"id": "ses_..."}
    POST /v1/sessions/{session_id}/messages

``messages`` runs one agent turn. With ``Accept: text/event-stream`` it returns
the turn as Server-Sent Events — one frame per event the agent produced, then a
final ``done`` frame; otherwise it returns ``{"events": [...]}`` once the turn
completes. NOTE: the AgentService's RunTurn is unary (it returns the whole turn
at once), so today the SSE frames flush together when the turn finishes rather
than incrementally. The wire contract is stable: if RunTurn becomes
server-streaming later, ``_turn_events`` starts yielding mid-turn and SSE clients
get live events with no change on their side.

``create_app`` takes a FunkyClient so tests can inject fakes; ``main`` builds the
real client from the environment / flags and serves it with uvicorn.
"""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import AsyncIterator, Iterator

from connectrpc.errors import ConnectError
from google.protobuf import json_format
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from funky.type.v1 import agent_pb2, event_pb2

from .client import FunkyClient

# Local defaults match the backends' own default ports (see the CLI), so the
# server runs with no env set; Cloud Run overrides each via an env var.
_URL_ENV = {
    "config_registry_url": ("CONFIG_REGISTRY_URL", "http://127.0.0.1:8080"),
    "session_store_url": ("SESSION_STORE_URL", "http://127.0.0.1:8081"),
    "sandbox_runtime_url": ("SANDBOX_RUNTIME_URL", "http://127.0.0.1:8082"),
    "agent_service_url": ("AGENT_SERVICE_URL", "http://127.0.0.1:8083"),
}


def default_urls() -> dict[str, str]:
    """The four backend URLs from the environment, each with a local fallback."""
    return {key: os.environ.get(env, default) for key, (env, default) in _URL_ENV.items()}


def create_app(client: FunkyClient) -> Starlette:
    """Build the ASGI app over a FunkyClient (injected, so tests pass fakes)."""

    async def health(_: Request) -> Response:
        return JSONResponse({"status": "ok"})

    async def create_agent(request: Request) -> Response:
        body = await _json_body(request)
        config = agent_pb2.AgentConfig(
            name=body.get("name", ""),
            model=body.get("model", ""),
            system_prompt=body.get("system_prompt", ""),
        )
        agent_id = await run_in_threadpool(client.agents.create, config)
        return JSONResponse({"id": agent_id}, status_code=201)

    async def create_environment(request: Request) -> Response:
        # EnvironmentConfig is empty today, so the body is ignored (but tolerated).
        await _json_body(request, optional=True)
        env_id = await run_in_threadpool(client.environments.create)
        return JSONResponse({"id": env_id}, status_code=201)

    async def create_session(request: Request) -> Response:
        body = await _json_body(request)
        agent_id = _require(body, "agent_id")
        environment_id = _require(body, "environment_id")
        session_id = await run_in_threadpool(
            client.sessions.create, agent_id, environment_id
        )
        return JSONResponse({"id": session_id}, status_code=201)

    async def send_message(request: Request) -> Response:
        session_id = request.path_params["session_id"]
        body = await _json_body(request)
        prompt = _require(body, "prompt")

        if "text/event-stream" in request.headers.get("accept", ""):
            return StreamingResponse(
                _sse(client, session_id, prompt),
                media_type="text/event-stream",
                # Defeat proxy buffering so frames reach the client promptly.
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        events = await run_in_threadpool(client.sessions.send, session_id, prompt)
        return JSONResponse({"events": [_event_dict(e) for e in events]})

    routes = [
        # NB: not "/healthz" — Google's frontend reserves that path and answers
        # it with its own 404 before the request reaches a Cloud Run container,
        # so the health route would be unreachable exactly where it's needed.
        Route("/health", health, methods=["GET"]),
        Route("/v1/agents", create_agent, methods=["POST"]),
        Route("/v1/environments", create_environment, methods=["POST"]),
        Route("/v1/sessions", create_session, methods=["POST"]),
        Route(
            "/v1/sessions/{session_id}/messages", send_message, methods=["POST"]
        ),
    ]
    return Starlette(
        routes=routes,
        exception_handlers={
            _BadRequest: _bad_request_handler,
            ConnectError: _connect_error_handler,
        },
    )


async def _sse(client: FunkyClient, session_id: str, prompt: str) -> AsyncIterator[str]:
    """Stream a turn as SSE frames: one per event, then a ``done`` (or ``error``)."""
    try:
        events = await run_in_threadpool(client.sessions.send, session_id, prompt)
    except ConnectError as err:
        yield _frame("error", {"code": err.code.name, "message": str(err)})
        return
    count = 0
    for event in _turn_events(events):
        count += 1
        yield _frame(event.WhichOneof("payload") or "event", _event_dict(event))
    yield _frame("done", {"session_id": session_id, "count": count})


def _turn_events(events) -> Iterator[event_pb2.Event]:
    """The events of one turn, in order.

    A seam for streaming: RunTurn is unary today, so this just replays the list
    the turn returned. When RunTurn becomes server-streaming, this yields events
    as they arrive and the SSE handler streams them live, unchanged.
    """
    yield from events


def _frame(event_type: str, data: dict) -> str:
    """One SSE frame: an event name and a JSON data line."""
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


def _event_dict(event: event_pb2.Event) -> dict:
    """An Event as JSON, snake_case to match this API's REST convention."""
    return json_format.MessageToDict(event, preserving_proto_field_name=True)


class _BadRequest(Exception):
    """A malformed request body or a missing required field (-> HTTP 400)."""


async def _json_body(request: Request, *, optional: bool = False) -> dict:
    """Parse the JSON body into a dict; raise _BadRequest on anything else.

    With ``optional``, an empty body becomes ``{}`` (for endpoints whose body is
    not required, like creating an environment).
    """
    raw = await request.body()
    if not raw:
        if optional:
            return {}
        raise _BadRequest("request body must be a JSON object")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as err:
        raise _BadRequest(f"invalid JSON: {err}") from err
    if not isinstance(body, dict):
        raise _BadRequest("request body must be a JSON object")
    return body


def _require(body: dict, field: str) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not value:
        raise _BadRequest(f"missing required field: {field!r}")
    return value


def _bad_request_handler(_: Request, exc: _BadRequest) -> Response:
    return JSONResponse({"error": str(exc)}, status_code=400)


def _connect_error_handler(_: Request, exc: ConnectError) -> Response:
    # Map the backend's Connect status onto an HTTP status: not-found -> 404,
    # invalid argument -> 400, everything else -> 502 (a backend call failed).
    status = {"not_found": 404, "invalid_argument": 400}.get(exc.code.name, 502)
    return JSONResponse(
        {"error": str(exc), "code": exc.code.name}, status_code=status
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    # Off the backends' 8080–8083 so the whole stack can run locally at once.
    # Cloud Run passes $PORT.
    parser.add_argument("--port", type=int, default=8000)
    urls = default_urls()
    for key, (env, _default) in _URL_ENV.items():
        parser.add_argument(
            f"--{key.replace('_', '-')}",
            default=urls[key],
            help=f"base URL of the {key[:-4].replace('_', ' ')} (defaults to ${env})",
        )
    args = parser.parse_args()

    client = FunkyClient.from_urls(
        config_registry_url=args.config_registry_url,
        session_store_url=args.session_store_url,
        sandbox_runtime_url=args.sandbox_runtime_url,
        agent_service_url=args.agent_service_url,
    )
    app = create_app(client)

    import uvicorn

    print(
        f"FunkyClient HTTP server on http://{args.host}:{args.port}\n"
        f"  config registry  {args.config_registry_url}\n"
        f"  session store    {args.session_store_url}\n"
        f"  sandbox runtime  {args.sandbox_runtime_url}\n"
        f"  agent service    {args.agent_service_url}",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
