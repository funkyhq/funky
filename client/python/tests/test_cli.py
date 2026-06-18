"""Exercise the funky-chat REPL without a terminal: a fake client whose
``sessions.send`` returns canned events, and ``input`` scripted with a list of
lines. Captures stdout to check what the user would see."""

from __future__ import annotations

import builtins

from funky.type.v1 import event_pb2

from funky_client import cli


def _agent_message(text: str) -> event_pb2.Event:
    return event_pb2.Event(
        agent_message=event_pb2.AgentMessage(
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
        )
    )


def _tool_use(name: str, command: str) -> event_pb2.Event:
    use = event_pb2.AgentToolUse(id="toolu_1", name=name)
    use.input.update({"command": command})
    return event_pb2.Event(agent_tool_use=use)


def _tool_result(text: str, is_error: bool = False) -> event_pb2.Event:
    return event_pb2.Event(
        agent_tool_result=event_pb2.AgentToolResult(
            tool_use_id="toolu_1",
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))],
            is_error=is_error,
        )
    )


class _Sessions:
    def __init__(self, responses: list[list[event_pb2.Event]]) -> None:
        self._responses = list(responses)
        self.sent: list[tuple[str, str]] = []

    def send(self, session_id: str, prompt: str) -> list[event_pb2.Event]:
        self.sent.append((session_id, prompt))
        return self._responses.pop(0)


class FakeClient:
    def __init__(self, responses: list[list[event_pb2.Event]]) -> None:
        self.sessions = _Sessions(responses)


def _script_input(monkeypatch, lines: list[str]) -> None:
    it = iter(lines)
    monkeypatch.setattr(builtins, "input", lambda prompt="": next(it))


def test_chat_sends_each_line_and_prints_replies(capsys, monkeypatch):
    _script_input(monkeypatch, ["what is 2+2?", "exit"])
    client = FakeClient([[_agent_message("4")]])

    cli._chat(client, "ses_1")

    # The line was sent as a turn; 'exit' ended the loop before being sent.
    assert client.sessions.sent == [("ses_1", "what is 2+2?")]
    assert "agent> 4" in capsys.readouterr().out


def test_chat_renders_tool_activity(capsys, monkeypatch):
    _script_input(monkeypatch, ["run uname", "exit"])
    client = FakeClient(
        [[_tool_use("bash", "uname"), _tool_result("Linux\n"), _agent_message("You're on Linux.")]]
    )

    cli._chat(client, "ses_1")

    out = capsys.readouterr().out
    assert "· bash: uname" in out
    assert "Linux" in out
    assert "agent> You're on Linux." in out


def test_blank_lines_are_skipped(capsys, monkeypatch):
    _script_input(monkeypatch, ["", "  ", "hi", "exit"])
    client = FakeClient([[_agent_message("hello")]])

    cli._chat(client, "ses_1")

    # Only the non-blank line was sent.
    assert client.sessions.sent == [("ses_1", "hi")]


def test_eof_ends_the_loop(monkeypatch):
    def _eof(prompt=""):
        raise EOFError

    monkeypatch.setattr(builtins, "input", _eof)
    client = FakeClient([])

    cli._chat(client, "ses_1")  # returns without sending anything

    assert client.sessions.sent == []


def test_render_marks_failed_tool_results(capsys):
    cli._render(_tool_result("boom\n[exit code 1]", is_error=True))

    assert "(error)" in capsys.readouterr().out
