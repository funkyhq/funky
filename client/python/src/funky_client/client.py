"""FunkyClient: the orchestrator that ties the four Funky services together.

Developers talk to this, not to the services directly. It is a thin layer over
the four generated ConnectRPC clients — ConfigRegistry, SessionStore,
SandboxRuntime, AgentService — that resolves ids to configs and coordinates a
turn across all of them:

    client = FunkyClient.from_urls(
        config_registry_url="http://127.0.0.1:8080",
        session_store_url="http://127.0.0.1:8081",
        sandbox_runtime_url="http://127.0.0.1:8082",
        agent_service_url="http://127.0.0.1:8083",
    )
    agent_id = client.agents.create(AgentConfig(name="coder", model="...", system_prompt="..."))
    env_id = client.environments.create()
    session_id = client.sessions.create(agent_id, env_id)
    events = client.sessions.send(session_id, "List the files in the repo.")

The constructor takes the four clients directly, so tests can pass fakes;
``from_urls`` is the convenience that builds the real ConnectRPC clients.
"""

from __future__ import annotations

from funky.agent.v1 import agent_service_pb2 as agent_service_pb
from funky.agent.v1.agent_service_connect import AgentServiceClientSync
from funky.registry.v1 import config_registry_pb2 as registry_pb
from funky.registry.v1.config_registry_connect import ConfigRegistryClientSync
from funky.sandbox.v1 import sandbox_runtime_pb2 as sandbox_pb
from funky.sandbox.v1.sandbox_runtime_connect import SandboxRuntimeClientSync
from funky.session.v1 import session_store_pb2 as session_pb
from funky.session.v1.session_store_connect import SessionStoreClientSync
from funky.type.v1 import agent_pb2, environment_pb2, event_pb2


class FunkyClient:
    """Coordinates the ConfigRegistry, SessionStore, SandboxRuntime, and
    AgentService behind one small API (``agents``, ``environments``, ``sessions``)."""

    def __init__(
        self, config_registry, session_store, sandbox_runtime, agent_service
    ) -> None:
        self._config_registry = config_registry
        self._session_store = session_store
        self._sandbox_runtime = sandbox_runtime
        self._agent_service = agent_service
        self.agents = _Agents(self)
        self.environments = _Environments(self)
        self.sessions = _Sessions(self)

    @classmethod
    def from_urls(
        cls,
        *,
        config_registry_url: str,
        session_store_url: str,
        sandbox_runtime_url: str,
        agent_service_url: str,
    ) -> "FunkyClient":
        """Build a client from the four service base URLs."""
        return cls(
            ConfigRegistryClientSync(config_registry_url),
            SessionStoreClientSync(session_store_url),
            SandboxRuntimeClientSync(sandbox_runtime_url),
            AgentServiceClientSync(agent_service_url),
        )


class _Agents:
    """``client.agents`` — agent configs in the ConfigRegistry."""

    def __init__(self, client: FunkyClient) -> None:
        self._client = client

    def create(self, config: agent_pb2.AgentConfig) -> str:
        """Store an agent config and return its registry id."""
        response = self._client._config_registry.create_agent(
            registry_pb.CreateAgentRequest(config=config)
        )
        return response.id


class _Environments:
    """``client.environments`` — environment configs in the ConfigRegistry."""

    def __init__(self, client: FunkyClient) -> None:
        self._client = client

    def create(self, config: environment_pb2.EnvironmentConfig | None = None) -> str:
        """Store an environment config and return its registry id.

        EnvironmentConfig is empty today, so this is callable with no argument.
        """
        response = self._client._config_registry.create_environment(
            registry_pb.CreateEnvironmentRequest(
                config=config or environment_pb2.EnvironmentConfig()
            )
        )
        return response.id


class _Sessions:
    """``client.sessions`` — sessions and the turns run in them."""

    def __init__(self, client: FunkyClient) -> None:
        self._client = client

    def create(self, agent_id: str, environment_id: str) -> str:
        """Open a session for an agent in an environment; return its id.

        Resolves the agent id to its config and snapshots it into the session; the
        environment stays a reference by id, resolved per turn in ``send``.
        """
        agent_config = self._client._config_registry.get_agent(
            registry_pb.GetAgentRequest(id=agent_id)
        ).config
        session = self._client._session_store.create_session(
            session_pb.CreateSessionRequest(
                agent_config=agent_config, environment_config_id=environment_id
            )
        ).session
        return session.id

    def send(
        self, session_id: str, prompt: str | event_pb2.UserMessage
    ) -> list[event_pb2.Event]:
        """Send a user prompt, run one agent turn, and return the agent's events.

        This is the orchestration the other three methods build up to. It:
          1. resolves the session and its environment config,
          2. reads the prior history and persists the new user prompt,
          3. provisions a sandbox from the session's agent + the environment,
          4. runs the turn against the prior history, and
          5. persists every event the agent produces, tearing the sandbox down
             afterwards even if the turn fails.

        Returns the agent's events as stored (with their assigned ids).
        """
        client = self._client
        session = client._session_store.get_session(
            session_pb.GetSessionRequest(id=session_id)
        ).session
        environment = client._config_registry.get_environment(
            registry_pb.GetEnvironmentRequest(id=session.environment_config_id)
        ).config
        # History is the conversation *before* this prompt; the prompt is passed to
        # the turn separately, so it is not double-counted.
        history = client._session_store.list_events(
            session_pb.ListEventsRequest(session_id=session_id)
        ).events

        user_message = _user_message(prompt)
        client._session_store.append_event(
            session_pb.AppendEventRequest(
                session_id=session_id,
                event=event_pb2.Event(user_message=user_message),
            )
        )

        sandbox = client._sandbox_runtime.create_sandbox(
            sandbox_pb.CreateSandboxRequest(
                agent_config=session.agent_config, environment_config=environment
            )
        ).sandbox
        try:
            response = client._agent_service.run_turn(
                agent_service_pb.RunTurnRequest(
                    agent_config=session.agent_config,
                    events=history,
                    prompt=user_message,
                    sandbox=sandbox,
                )
            )
            produced = []
            for event in response.events:
                stored = client._session_store.append_event(
                    session_pb.AppendEventRequest(session_id=session_id, event=event)
                ).event
                produced.append(stored)
            return produced
        finally:
            client._sandbox_runtime.destroy_sandbox(
                sandbox_pb.DestroySandboxRequest(sandbox_id=sandbox.id)
            )


def _user_message(prompt: str | event_pb2.UserMessage) -> event_pb2.UserMessage:
    """A prompt as a UserMessage: a bare string becomes one text block."""
    if isinstance(prompt, event_pb2.UserMessage):
        return prompt
    return event_pb2.UserMessage(
        content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=prompt))]
    )
