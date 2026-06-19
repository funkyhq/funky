"""End-to-end test: boot the ASGI server on an ephemeral port and drive it with
the generated ConnectRPC client, exercising the real wire path (not the service
object directly).

The store's ORM is engine-agnostic, so by default this runs against an in-process
SQLite (aiosqlite) database — no Cloud SQL instance required. Point
``FUNKY_SESSION_STORE_TEST_DATABASE_URL`` at a disposable async Postgres URL
(e.g. ``postgresql+asyncpg://...``) to run the identical suite against Postgres.
"""

from __future__ import annotations

import asyncio
import os
import socket
import threading
import time

import pytest
import uvicorn
from connectrpc.code import Code
from connectrpc.errors import ConnectError
from sqlalchemy.ext.asyncio import create_async_engine

from funky.session.v1 import session_store_pb2 as pb
from funky.session.v1.session_store_connect import (
    SessionStoreASGIApplication,
    SessionStoreClientSync,
)
from funky.type.v1 import agent_pb2, event_pb2

from funky_session_store_postgres.models import Base
from funky_session_store_postgres.service import SessionStoreService
from funky_session_store_postgres.store import SqlSessionStore


@pytest.fixture
def client(tmp_path):
    """A running SessionStore server over a fresh schema; yields the client.

    The engine, schema reset, and server all live in one event loop inside the
    server thread so the async connection pool is used where it's created.
    """
    db_url = os.environ.get(
        "FUNKY_SESSION_STORE_TEST_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'session_store.db'}",
    )

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]

    box: dict = {}

    async def run() -> None:
        engine = create_async_engine(db_url)
        store = SqlSessionStore(engine)
        async with engine.begin() as conn:  # disposable schema, repeatable runs
            await conn.run_sync(Base.metadata.drop_all)
        await store.create_all()

        app = SessionStoreASGIApplication(SessionStoreService(store))
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
        box["server"] = server
        try:
            await server.serve(sockets=[sock])
        finally:
            await engine.dispose()

    def thread_main() -> None:
        try:
            asyncio.run(run())
        except BaseException as exc:  # surface startup failures to the test
            box["error"] = exc

    thread = threading.Thread(target=thread_main, daemon=True)
    thread.start()

    deadline = time.time() + 15
    while time.time() < deadline:
        if "error" in box:
            raise box["error"]
        server = box.get("server")
        if server is not None and server.started:
            break
        time.sleep(0.02)
    else:
        raise RuntimeError("server did not start in time")

    try:
        yield SessionStoreClientSync(f"http://127.0.0.1:{port}")
    finally:
        if server := box.get("server"):
            server.should_exit = True
        thread.join(timeout=5)
        sock.close()


def _user_event(text: str) -> event_pb2.Event:
    """A user-message event carrying a single text block."""
    return event_pb2.Event(
        user_message=event_pb2.UserMessage(
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
        )
    )


def _create_session(client) -> str:
    created = client.create_session(
        pb.CreateSessionRequest(
            agent_config=agent_pb2.AgentConfig(
                name="researcher",
                model="gemini-3.5-flash",
                system_prompt="You are a careful research assistant.",
            ),
            environment_config_id="env_local",
        )
    )
    return created.session.id


def test_session_round_trip(client):
    created = client.create_session(
        pb.CreateSessionRequest(
            agent_config=agent_pb2.AgentConfig(
                name="researcher",
                model="gemini-3.5-flash",
                system_prompt="You are a careful research assistant.",
            ),
            environment_config_id="env_local",
        )
    )
    assert created.session.id.startswith("ses_")

    fetched = client.get_session(pb.GetSessionRequest(id=created.session.id))
    assert fetched.session.id == created.session.id
    assert fetched.session.agent_config.name == "researcher"
    assert fetched.session.agent_config.model == "gemini-3.5-flash"
    assert (
        fetched.session.agent_config.system_prompt
        == "You are a careful research assistant."
    )
    assert fetched.session.environment_config_id == "env_local"


def test_append_and_list_events(client):
    session_id = _create_session(client)

    # A fresh session has no events yet.
    assert client.list_events(pb.ListEventsRequest(session_id=session_id)).events == []

    appended = client.append_event(
        pb.AppendEventRequest(session_id=session_id, event=_user_event("hello"))
    )
    # The store assigns id, session_id, and processed_at on the stored copy.
    assert appended.event.id.startswith("evt_")
    assert appended.event.session_id == session_id
    assert appended.event.HasField("processed_at")
    assert appended.event.user_message.content[0].text.text == "hello"

    agent_turn = client.append_event(
        pb.AppendEventRequest(
            session_id=session_id,
            event=event_pb2.Event(
                agent_message=event_pb2.AgentMessage(
                    content=[
                        event_pb2.ContentBlock(
                            text=event_pb2.TextBlock(text="hi there")
                        )
                    ]
                )
            ),
        )
    )

    # ListEvents returns them in append order with distinct ids.
    listed = client.list_events(pb.ListEventsRequest(session_id=session_id)).events
    assert [e.id for e in listed] == [appended.event.id, agent_turn.event.id]
    assert listed[0].user_message.content[0].text.text == "hello"
    assert listed[1].agent_message.content[0].text.text == "hi there"


def test_events_are_scoped_per_session(client):
    first = _create_session(client)
    second = _create_session(client)

    client.append_event(
        pb.AppendEventRequest(session_id=first, event=_user_event("for first"))
    )

    assert [
        e.user_message.content[0].text.text
        for e in client.list_events(pb.ListEventsRequest(session_id=first)).events
    ] == ["for first"]
    assert client.list_events(pb.ListEventsRequest(session_id=second)).events == []


def test_get_unknown_session_is_not_found(client):
    with pytest.raises(ConnectError) as excinfo:
        client.get_session(pb.GetSessionRequest(id="ses_missing"))
    assert excinfo.value.code == Code.NOT_FOUND


def test_append_to_unknown_session_is_not_found(client):
    with pytest.raises(ConnectError) as excinfo:
        client.append_event(
            pb.AppendEventRequest(session_id="ses_missing", event=_user_event("hi"))
        )
    assert excinfo.value.code == Code.NOT_FOUND


def test_list_events_unknown_session_is_not_found(client):
    with pytest.raises(ConnectError) as excinfo:
        client.list_events(pb.ListEventsRequest(session_id="ses_missing"))
    assert excinfo.value.code == Code.NOT_FOUND
