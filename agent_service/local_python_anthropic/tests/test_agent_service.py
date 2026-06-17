"""End-to-end test: boot the WSGI server on an ephemeral port and drive RunTurn
through the generated ConnectRPC client, with a fake Anthropic client and a fake
SandboxRuntime standing in for the model and the sandbox so the test stays
hermetic — no API key, no Docker, no network."""

from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field

import pytest
from waitress.server import create_server

from funky.agent.v1 import agent_service_pb2 as pb
from funky.agent.v1.agent_service_connect import (
    AgentServiceClientSync,
    AgentServiceWSGIApplication,
)
from funky.type.v1 import agent_pb2, event_pb2, sandbox_pb2

from funky_agent_service_anthropic.service import AgentServiceAnthropic


# --- fake Anthropic model -------------------------------------------------


@dataclass
class _Text:
    """A text content block, shaped like the SDK's TextBlock."""

    text: str
    type: str = "text"


@dataclass
class _ToolUse:
    """A tool_use content block, shaped like the SDK's ToolUseBlock."""

    id: str
    name: str
    input: dict
    type: str = "tool_use"


@dataclass
class _Response:
    """An Anthropic Messages response: content blocks plus a stop reason."""

    content: list
    stop_reason: str = "end_turn"


class _Messages:
    """The ``client.messages`` namespace: returns the canned responses in order,
    one per create() call, and records each call's kwargs for inspection."""

    def __init__(self, responses: list, calls: list) -> None:
        self._responses = list(responses)
        self._calls = calls

    def create(self, **kwargs) -> _Response:
        # Snapshot the kwargs: the loop keeps mutating the messages list in place
        # after the call, and the real SDK serializes the request, so a live
        # reference would not reflect what was actually sent.
        self._calls.append(copy.deepcopy(kwargs))
        return self._responses.pop(0)


@dataclass
class FakeAnthropic:
    """Stands in for ``anthropic.Anthropic``: ``messages.create`` returns the next
    canned response and stashes its kwargs in ``calls``."""

    responses: list
    calls: list = field(default_factory=list)

    def __post_init__(self) -> None:
        self.messages = _Messages(self.responses, self.calls)


# --- fake SandboxRuntime --------------------------------------------------


@dataclass
class _ExecResult:
    """An ExecCommandResponse stand-in."""

    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""


class FakeSandbox:
    """Stands in for the SandboxRuntime client: ``exec_command`` returns a canned
    result and records each request."""

    def __init__(self, result: _ExecResult | None = None) -> None:
        self._result = result or _ExecResult()
        self.calls: list = []

    def exec_command(self, request) -> _ExecResult:
        self.calls.append(request)
        return self._result


# --- harness --------------------------------------------------------------


@pytest.fixture
def serve():
    """Yields ``start(model, sandbox) -> client``: boots a server wired to the fake
    model and sandbox, returns a ConnectRPC client. Servers torn down at teardown."""
    started: list = []

    def start(model: FakeAnthropic, sandbox: FakeSandbox) -> AgentServiceClientSync:
        service = AgentServiceAnthropic(sandbox, client=model)
        server = create_server(
            AgentServiceWSGIApplication(service), host="127.0.0.1", port=0
        )
        port = server.socket.getsockname()[1]
        stopping = threading.Event()

        def run():
            try:
                server.run()
            except OSError:
                # close() shuts the listening socket out from under waitress's
                # select loop; that EBADF is expected only during teardown.
                if not stopping.is_set():
                    raise

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        started.append((server, thread, stopping))
        return AgentServiceClientSync(f"http://127.0.0.1:{port}")

    try:
        yield start
    finally:
        for server, thread, stopping in started:
            stopping.set()
            server.close()
            thread.join(timeout=5)


def _user(text: str) -> event_pb2.UserMessage:
    return event_pb2.UserMessage(
        content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
    )


def _agent_message(text: str) -> event_pb2.AgentMessage:
    return event_pb2.AgentMessage(
        content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
    )


def _agent_config(system_prompt: str = "You are a careful research assistant.") -> agent_pb2.AgentConfig:
    return agent_pb2.AgentConfig(
        name="researcher", model="claude-sonnet-4-6", system_prompt=system_prompt
    )


def _request(events=(), prompt="hi", sandbox_id="sbx_1", system="You are a careful research assistant.") -> pb.RunTurnRequest:
    return pb.RunTurnRequest(
        agent_config=_agent_config(system),
        events=list(events),
        prompt=_user(prompt),
        sandbox=sandbox_pb2.Sandbox(id=sandbox_id),
    )


# --- tests ----------------------------------------------------------------


def test_text_only_turn_returns_agent_messages(serve):
    sandbox = FakeSandbox()
    client = serve(FakeAnthropic([_Response([_Text("Hello"), _Text(" world")])]), sandbox)

    response = client.run_turn(_request())

    assert [
        e.agent_message.content[0].text.text for e in response.events
    ] == ["Hello", " world"]
    # No tool calls -> the sandbox is never touched.
    assert sandbox.calls == []
    # Events are payload-only: id/session_id/processed_at are the SessionStore's.
    assert all(
        e.id == "" and e.session_id == "" and not e.HasField("processed_at")
        for e in response.events
    )


def test_agent_runs_a_tool_in_the_sandbox(serve):
    model = FakeAnthropic(
        [
            _Response(
                [_ToolUse(id="toolu_1", name="bash", input={"command": "echo hi"})],
                stop_reason="tool_use",
            ),
            _Response([_Text("It printed hi.")]),
        ]
    )
    sandbox = FakeSandbox(_ExecResult(exit_code=0, stdout="hi\n"))
    client = serve(model, sandbox)

    response = client.run_turn(_request(prompt="run echo hi", sandbox_id="sbx_42"))

    # The command ran in the right sandbox, wrapped for a shell.
    [exec_call] = sandbox.calls
    assert exec_call.sandbox_id == "sbx_42"
    assert list(exec_call.command) == ["bash", "-c", "echo hi"]

    # The turn's events: the tool call, its result, then the agent's reply.
    use, result, message = response.events
    assert use.agent_tool_use.id == "toolu_1"
    assert use.agent_tool_use.name == "bash"
    assert use.agent_tool_use.input["command"] == "echo hi"
    assert result.agent_tool_result.tool_use_id == "toolu_1"
    assert result.agent_tool_result.content[0].text.text == "hi\n"
    assert result.agent_tool_result.is_error is False
    assert message.agent_message.content[0].text.text == "It printed hi."

    # The second model call carried the tool_use back and the tool_result in.
    second = model.calls[1]["messages"]
    assert second[-2] == {
        "role": "assistant",
        "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "bash", "input": {"command": "echo hi"}}
        ],
    }
    assert second[-1] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "hi\n", "is_error": False}
        ],
    }


def test_failed_command_is_flagged_as_an_error(serve):
    model = FakeAnthropic(
        [
            _Response(
                [_ToolUse(id="toolu_x", name="bash", input={"command": "false"})],
                stop_reason="tool_use",
            ),
            _Response([_Text("That failed.")]),
        ]
    )
    sandbox = FakeSandbox(_ExecResult(exit_code=1, stderr="boom"))
    client = serve(model, sandbox)

    response = client.run_turn(_request())

    result = response.events[1].agent_tool_result
    assert result.is_error is True
    assert "boom" in result.content[0].text.text
    assert "[exit code 1]" in result.content[0].text.text
    # The error flag is carried back to the model too.
    assert model.calls[1]["messages"][-1]["content"][0]["is_error"] is True


def test_history_with_tool_events_round_trips_to_the_model(serve):
    model = FakeAnthropic([_Response([_Text("ok")])])
    sandbox = FakeSandbox()
    client = serve(model, sandbox)

    use = event_pb2.AgentToolUse(id="toolu_h", name="bash")
    use.input.update({"command": "ls"})
    result = event_pb2.AgentToolResult(
        tool_use_id="toolu_h",
        content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text="a\nb"))],
    )
    history = [
        event_pb2.Event(user_message=_user("list files")),
        event_pb2.Event(agent_tool_use=use),
        event_pb2.Event(agent_tool_result=result),
    ]
    client.run_turn(_request(events=history, prompt="thanks"))

    # The prior tool call and its result reconstruct into a valid Anthropic
    # exchange: tool_use in an assistant message, tool_result in a user message,
    # paired by id.
    messages = model.calls[0]["messages"]
    assert messages[0] == {"role": "user", "content": [{"type": "text", "text": "list files"}]}
    assert messages[1] == {
        "role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_h", "name": "bash", "input": {"command": "ls"}}],
    }
    assert messages[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_h", "content": "a\nb", "is_error": False},
            {"type": "text", "text": "thanks"},
        ],
    }


def test_history_and_prompt_become_anthropic_messages(serve):
    model = FakeAnthropic([_Response([_Text("ok")])])
    client = serve(model, FakeSandbox())

    history = [
        event_pb2.Event(user_message=_user("first question")),
        event_pb2.Event(agent_message=_agent_message("first answer")),
    ]
    client.run_turn(_request(events=history, prompt="second question"))

    [call] = model.calls
    assert call["model"] == "claude-sonnet-4-6"
    assert call["system"] == "You are a careful research assistant."
    assert call["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "first question"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "first answer"}]},
        {"role": "user", "content": [{"type": "text", "text": "second question"}]},
    ]


def test_empty_system_prompt_is_omitted(serve):
    model = FakeAnthropic([_Response([_Text("ok")])])
    client = serve(model, FakeSandbox())

    client.run_turn(_request(system=""))

    [call] = model.calls
    assert "system" not in call
