"""Drive FunkyClient against in-memory fakes of the four services, asserting the
orchestration: which service is called, with what, in what order. Each service's
own wire path is covered by its backend's tests; here the Client's coordination is
the thing under test, so the fakes are injected directly (no servers needed)."""

from __future__ import annotations

from funky.agent.v1 import agent_service_pb2 as agent_service_pb
from funky.registry.v1 import config_registry_pb2 as registry_pb
from funky.sandbox.v1 import sandbox_runtime_pb2 as sandbox_pb
from funky.session.v1 import session_store_pb2 as session_pb
from funky.type.v1 import (
    agent_pb2,
    event_pb2,
    sandbox_pb2,
    session_pb2,
)

from funky_client import FunkyClient


class FakeConfigRegistry:
    """In-memory ConfigRegistry: mints ids and stores configs."""

    def __init__(self) -> None:
        self.agents: dict[str, agent_pb2.AgentConfig] = {}
        self.environments: dict[str, object] = {}
        self._n = 0

    def create_agent(self, request):
        self._n += 1
        agent_id = f"agt_{self._n}"
        self.agents[agent_id] = request.config
        return registry_pb.CreateAgentResponse(id=agent_id)

    def get_agent(self, request):
        return registry_pb.GetAgentResponse(config=self.agents[request.id])

    def create_environment(self, request):
        self._n += 1
        env_id = f"env_{self._n}"
        self.environments[env_id] = request.config
        return registry_pb.CreateEnvironmentResponse(id=env_id)

    def get_environment(self, request):
        return registry_pb.GetEnvironmentResponse(config=self.environments[request.id])


class FakeSessionStore:
    """In-memory SessionStore: mints ids and keeps an append-only event log."""

    def __init__(self) -> None:
        self.sessions: dict[str, session_pb2.Session] = {}
        self.events: dict[str, list[event_pb2.Event]] = {}
        self._n = 0

    def create_session(self, request):
        self._n += 1
        session = session_pb2.Session(
            id=f"ses_{self._n}",
            agent_config=request.agent_config,
            environment_config_id=request.environment_config_id,
        )
        self.sessions[session.id] = session
        self.events[session.id] = []
        return session_pb.CreateSessionResponse(session=session)

    def get_session(self, request):
        return session_pb.GetSessionResponse(session=self.sessions[request.id])

    def append_event(self, request):
        self._n += 1
        stored = event_pb2.Event()
        stored.CopyFrom(request.event)
        stored.id = f"evt_{self._n}"
        stored.session_id = request.session_id
        stored.processed_at.GetCurrentTime()
        self.events[request.session_id].append(stored)
        return session_pb.AppendEventResponse(event=stored)

    def list_events(self, request):
        return session_pb.ListEventsResponse(events=self.events[request.session_id])


class FakeSandboxRuntime:
    """In-memory SandboxRuntime: records create/destroy and hands out sandbox ids."""

    def __init__(self) -> None:
        self.created: list = []
        self.destroyed: list[str] = []
        self._n = 0

    def create_sandbox(self, request):
        self._n += 1
        self.created.append(request)
        return sandbox_pb.CreateSandboxResponse(
            sandbox=sandbox_pb2.Sandbox(id=f"sbx_{self._n}")
        )

    def destroy_sandbox(self, request):
        self.destroyed.append(request.sandbox_id)
        return sandbox_pb.DestroySandboxResponse()


class FakeAgentService:
    """In-memory AgentService: records each run_turn and replies with canned
    events, one response (a list of events) per call."""

    def __init__(self, responses: list[list[event_pb2.Event]]) -> None:
        self._responses = list(responses)
        self.requests: list = []

    def run_turn(self, request):
        self.requests.append(request)
        return agent_service_pb.RunTurnResponse(events=self._responses.pop(0))


def _agent_event(text: str) -> event_pb2.Event:
    return event_pb2.Event(
        agent_message=event_pb2.AgentMessage(
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
        )
    )


def _client(agent_responses):
    registry = FakeConfigRegistry()
    store = FakeSessionStore()
    runtime = FakeSandboxRuntime()
    agent = FakeAgentService(agent_responses)
    return FunkyClient(registry, store, runtime, agent), registry, store, runtime, agent


def test_create_resolves_the_agent_and_snapshots_it_into_the_session():
    client, registry, store, _, _ = _client([])

    agent_id = client.agents.create(
        agent_pb2.AgentConfig(name="coder", model="claude-sonnet-4-6", system_prompt="be brief")
    )
    env_id = client.environments.create()
    session_id = client.sessions.create(agent_id, env_id)

    # Ids come back from the registry/store.
    assert agent_id in registry.agents
    assert env_id in registry.environments
    # The session snapshots the resolved agent config and references the env by id.
    session = store.sessions[session_id]
    assert session.agent_config.model == "claude-sonnet-4-6"
    assert session.environment_config_id == env_id


def test_send_runs_a_turn_and_persists_the_whole_exchange():
    client, _, store, runtime, agent = _client([[_agent_event("hi there")]])

    agent_id = client.agents.create(
        agent_pb2.AgentConfig(name="coder", model="m", system_prompt="s")
    )
    session_id = client.sessions.create(agent_id, client.environments.create())

    produced = client.sessions.send(session_id, "hello")

    # The AgentService got the snapshot config, the (empty) prior history, the
    # prompt, and the sandbox that was provisioned for the turn.
    [run] = agent.requests
    assert run.agent_config.model == "m"
    assert list(run.events) == []
    assert run.prompt.content[0].text.text == "hello"
    assert len(runtime.created) == 1
    assert run.sandbox.id.startswith("sbx_")

    # The sandbox was created from the session's agent + env, then torn down.
    assert runtime.destroyed == [run.sandbox.id]

    # The user prompt and the agent's reply were persisted, in order.
    history = store.events[session_id]
    assert [e.WhichOneof("payload") for e in history] == ["user_message", "agent_message"]
    assert history[0].user_message.content[0].text.text == "hello"
    assert history[1].agent_message.content[0].text.text == "hi there"

    # send returns the agent's events as stored (with assigned ids).
    assert [e.agent_message.content[0].text.text for e in produced] == ["hi there"]
    assert all(e.id for e in produced)


def test_history_accumulates_across_turns():
    client, _, store, _, agent = _client(
        [[_agent_event("first reply")], [_agent_event("second reply")]]
    )
    agent_id = client.agents.create(
        agent_pb2.AgentConfig(name="coder", model="m", system_prompt="s")
    )
    session_id = client.sessions.create(agent_id, client.environments.create())

    client.sessions.send(session_id, "first")
    client.sessions.send(session_id, "second")

    # The second turn is run against the first turn's persisted history (the first
    # user prompt and the first agent reply), with the new prompt passed separately.
    first_run, second_run = agent.requests
    assert list(first_run.events) == []
    assert [e.WhichOneof("payload") for e in second_run.events] == [
        "user_message",
        "agent_message",
    ]
    assert second_run.events[0].user_message.content[0].text.text == "first"
    assert second_run.events[1].agent_message.content[0].text.text == "first reply"

    # The full exchange is in the store, in order.
    assert [
        e.WhichOneof("payload") for e in store.events[session_id]
    ] == ["user_message", "agent_message", "user_message", "agent_message"]


def test_sandbox_is_destroyed_even_when_the_turn_fails():
    client, _, store, runtime, _ = _client([])
    agent_id = client.agents.create(
        agent_pb2.AgentConfig(name="coder", model="m", system_prompt="s")
    )
    session_id = client.sessions.create(agent_id, client.environments.create())

    # FakeAgentService was given no responses, so run_turn raises (pop from empty).
    raised = False
    try:
        client.sessions.send(session_id, "hello")
    except IndexError:
        raised = True

    assert raised
    # The sandbox was still torn down, and the user prompt was still persisted.
    assert len(runtime.created) == 1
    assert runtime.destroyed == ["sbx_1"]
    assert [e.WhichOneof("payload") for e in store.events[session_id]] == ["user_message"]
