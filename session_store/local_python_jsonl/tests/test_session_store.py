"""End-to-end test: boot the WSGI server on an ephemeral port and drive it with
the generated ConnectRPC client, exercising the real wire path (not the service
object directly)."""

from __future__ import annotations

import threading

import pytest
from connectrpc.code import Code
from connectrpc.errors import ConnectError
from waitress.server import create_server

from funky.session.v1 import session_store_pb2 as pb
from funky.session.v1.session_store_connect import (
    SessionStoreClientSync,
    SessionStoreWSGIApplication,
)
from funky.type.v1 import agent_pb2, event_pb2

from funky_session_store_jsonl.service import SessionStoreService


@pytest.fixture
def store(tmp_path):
    """A running SessionStore server; yields (client, data_dir)."""
    app = SessionStoreWSGIApplication(SessionStoreService(tmp_path))
    server = create_server(app, host="127.0.0.1", port=0)
    port = server.socket.getsockname()[1]
    stopping = threading.Event()

    def serve():
        try:
            server.run()
        except OSError:
            # close() shuts the listening socket out from under waitress's
            # asyncore select loop; that EBADF is expected only during teardown.
            if not stopping.is_set():
                raise

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield SessionStoreClientSync(f"http://127.0.0.1:{port}"), tmp_path
    finally:
        stopping.set()
        server.close()
        thread.join(timeout=5)


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


def test_session_round_trip(store):
    client, data_dir = store

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
    assert fetched.session.environment_config_id == "env_local"

    # Persisted as exactly one JSONL line.
    assert (data_dir / "sessions.jsonl").read_text().splitlines() != []


def test_append_and_list_events(store):
    client, _ = store
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


def test_events_are_scoped_per_session(store):
    client, _ = store
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


def test_get_unknown_session_is_not_found(store):
    client, _ = store

    with pytest.raises(ConnectError) as excinfo:
        client.get_session(pb.GetSessionRequest(id="ses_missing"))
    assert excinfo.value.code == Code.NOT_FOUND


def test_append_to_unknown_session_is_not_found(store):
    client, _ = store

    with pytest.raises(ConnectError) as excinfo:
        client.append_event(
            pb.AppendEventRequest(session_id="ses_missing", event=_user_event("hi"))
        )
    assert excinfo.value.code == Code.NOT_FOUND


def test_list_events_unknown_session_is_not_found(store):
    client, _ = store

    with pytest.raises(ConnectError) as excinfo:
        client.list_events(pb.ListEventsRequest(session_id="ses_missing"))
    assert excinfo.value.code == Code.NOT_FOUND
