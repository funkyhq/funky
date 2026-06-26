"""Drive the HTTP server against a FunkyClient over the in-memory fakes, asserting
the JSON/REST + SSE surface: the four endpoints round-trip ids, a turn returns the
agent's events (as JSON and as SSE frames), and bad input / backend errors map to
the right status. The orchestration itself is covered by test_client; here the
HTTP layer on top of it is the thing under test, so the same fakes are reused."""

from __future__ import annotations

import json

from starlette.testclient import TestClient

from funky_client import FunkyClient
from funky_client.server import create_app

# Reuse the four in-memory fakes (and the event helper) from the client tests.
from test_client import (
    FakeAgentService,
    FakeConfigRegistry,
    FakeSandboxRuntime,
    FakeSessionStore,
    _agent_event,
)


def _app(agent_responses):
    agent = FakeAgentService(agent_responses)
    client = FunkyClient(
        FakeConfigRegistry(), FakeSessionStore(), FakeSandboxRuntime(), agent
    )
    return TestClient(create_app(client)), agent


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    """Parse an SSE body into (event, data) pairs."""
    frames = []
    for block in text.strip().split("\n\n"):
        event = data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        frames.append((event, data))
    return frames


def test_health():
    client, _ = _app([])
    assert client.get("/health").json() == {"status": "ok"}


def test_create_agent_environment_session_round_trip():
    client, _ = _app([])

    agent = client.post(
        "/v1/agents",
        json={"name": "coder", "model": "m", "system_prompt": "s"},
    )
    assert agent.status_code == 201
    agent_id = agent.json()["id"]
    assert agent_id.startswith("agt_")

    env = client.post("/v1/environments", json={})
    assert env.status_code == 201
    env_id = env.json()["id"]
    assert env_id.startswith("env_")

    # Environment body is optional — no body works too.
    assert client.post("/v1/environments").status_code == 201

    session = client.post(
        "/v1/sessions", json={"agent_id": agent_id, "environment_id": env_id}
    )
    assert session.status_code == 201
    assert session.json()["id"].startswith("ses_")


def test_send_message_returns_events_as_json():
    client, agent = _app([[_agent_event("hi there")]])
    session_id = _start_session(client)

    resp = client.post(
        f"/v1/sessions/{session_id}/messages", json={"prompt": "hello"}
    )
    assert resp.status_code == 200
    events = resp.json()["events"]
    # The agent's reply comes back, snake_case, with its assigned id.
    assert events[0]["agent_message"]["content"][0]["text"]["text"] == "hi there"
    assert events[0]["id"]
    # The turn saw the prompt.
    assert agent.requests[0].prompt.content[0].text.text == "hello"


def test_send_message_streams_sse():
    client, _ = _app([[_agent_event("one"), _agent_event("two")]])
    session_id = _start_session(client)

    resp = client.post(
        f"/v1/sessions/{session_id}/messages",
        json={"prompt": "hello"},
        headers={"accept": "text/event-stream"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    frames = _parse_sse(resp.text)
    # One frame per produced event, then a terminal `done` carrying the count.
    assert [event for event, _ in frames] == ["agent_message", "agent_message", "done"]
    assert frames[0][1]["agent_message"]["content"][0]["text"]["text"] == "one"
    assert frames[-1][1] == {"session_id": session_id, "count": 2}


def test_missing_required_field_is_400():
    client, _ = _app([])
    assert client.post("/v1/sessions", json={"agent_id": "agt_1"}).status_code == 400
    assert client.post("/v1/agents", content=b"not json").status_code == 400
    session_id = _start_session(client)
    assert (
        client.post(f"/v1/sessions/{session_id}/messages", json={}).status_code == 400
    )


def _start_session(client: TestClient) -> str:
    agent_id = client.post(
        "/v1/agents", json={"name": "c", "model": "m", "system_prompt": "s"}
    ).json()["id"]
    env_id = client.post("/v1/environments", json={}).json()["id"]
    return client.post(
        "/v1/sessions", json={"agent_id": agent_id, "environment_id": env_id}
    ).json()["id"]
