"""The agent turn itself: prior history + a new prompt -> the agent's events.

This is a real tool-use loop. The agent is given a single ``bash`` tool; each
round it calls the model, and for every tool call the model makes it runs the
command in the sandbox through a SandboxRuntime client and feeds the result back,
looping until the model stops calling tools. This is the
``AgentService ..> SandboxRuntime : exec`` edge from the architecture.

The turn is stateless, as the AgentService contract requires — prior events are
passed in, never stored — and the Events it yields are payload-only: their Event
id, session_id, and processed_at are the SessionStore's to assign on append.
(``AgentToolUse.id`` is a different thing — the tool call's own handle, used to
pair a result with its call within the turn.)

Both clients are injected so the turn can run against the real Anthropic API and a
real SandboxRuntime in production, and against fakes in tests. The module speaks
the Anthropic Messages API's data shapes (a ``messages.create`` call, a response
whose ``.content`` is a list of typed blocks) rather than importing ``anthropic``,
which keeps it trivially fakeable.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

from connectrpc.errors import ConnectError
from google.protobuf import json_format

from funky.sandbox.v1 import sandbox_runtime_pb2
from funky.type.v1 import agent_pb2, event_pb2, sandbox_pb2

# Anthropic requires an explicit output cap on every request. 4096 is generous
# for a single chat turn and well under every current Claude model's ceiling; a
# `max_tokens` field on AgentConfig is the natural place to make this per-agent
# later.
DEFAULT_MAX_TOKENS = 4096

# Safety cap on tool-use rounds in one turn, so a model that keeps calling tools
# can't loop forever. Each round is one model call plus the tool calls it makes.
DEFAULT_MAX_ITERATIONS = 50

# The one tool the agent gets: run a shell command in the sandbox. Its input is
# an arbitrary JSON object per the schema; the model fills in `command`.
BASH_TOOL = {
    "name": "bash",
    "description": (
        "Run a shell command inside the sandbox and return its combined "
        "stdout and stderr."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run.",
            },
        },
        "required": ["command"],
    },
}


class AnthropicAgentLoop:
    """One agent turn backed by the Anthropic Messages API and a sandbox."""

    def __init__(
        self,
        client,
        sandbox_client,
        *,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
    ) -> None:
        self._client = client
        self._sandbox = sandbox_client
        self._max_tokens = max_tokens
        self._max_iterations = max_iterations

    def run_turn(
        self,
        agent_config: agent_pb2.AgentConfig,
        events: Sequence[event_pb2.Event],
        prompt: event_pb2.UserMessage,
        sandbox: sandbox_pb2.Sandbox,
    ) -> Iterator[event_pb2.Event]:
        """Run one turn and yield the Events the agent produces, in order.

        Text the model writes becomes an AgentMessage; every tool call becomes an
        AgentToolUse followed by the AgentToolResult from running it in the
        sandbox. The loop ends when the model finishes a response without calling
        a tool (or the iteration cap is hit).
        """
        messages = _to_messages(events, prompt)
        request = {
            "model": agent_config.model,
            "max_tokens": self._max_tokens,
            "tools": [BASH_TOOL],
        }
        # Omit `system` when empty rather than sending "": a blank system prompt
        # is a no-op, and leaving it off keeps the request minimal.
        if agent_config.system_prompt:
            request["system"] = agent_config.system_prompt

        for _ in range(self._max_iterations):
            response = self._client.messages.create(messages=messages, **request)

            assistant_content: list[dict] = []
            tool_results: list[dict] = []
            for block in response.content:
                if getattr(block, "type", None) == "text":
                    yield _agent_text_event(block.text)
                    assistant_content.append({"type": "text", "text": block.text})
                elif getattr(block, "type", None) == "tool_use":
                    yield _agent_tool_use_event(block)
                    assistant_content.append(
                        {
                            "type": "tool_use",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                        }
                    )
                    output, is_error = self._run_tool(sandbox.id, block)
                    yield _agent_tool_result_event(block.id, output, is_error)
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": output,
                            "is_error": is_error,
                        }
                    )

            messages.append({"role": "assistant", "content": assistant_content})
            # No tool calls this round -> the turn is done.
            if getattr(response, "stop_reason", None) != "tool_use":
                return
            messages.append({"role": "user", "content": tool_results})

    def _run_tool(self, sandbox_id: str, block) -> tuple[str, bool]:
        """Run a tool call in the sandbox; return (output, is_error).

        Only ``bash`` exists today. A failed RPC or a non-zero exit is surfaced as
        an errored result so the model can react, rather than aborting the turn.
        """
        command = block.input.get("command", "") if isinstance(block.input, dict) else ""
        argv = ["bash", "-c", command]
        try:
            result = self._sandbox.exec_command(
                sandbox_runtime_pb2.ExecCommandRequest(
                    sandbox_id=sandbox_id, command=argv
                )
            )
        except ConnectError as err:
            return f"sandbox exec failed: {err}", True
        return _format_output(result), result.exit_code != 0


def _to_messages(
    events: Sequence[event_pb2.Event], prompt: event_pb2.UserMessage
) -> list[dict]:
    """Build the Anthropic message list from prior events and the new prompt.

    Each event maps to a role and some content blocks; consecutive events of the
    same role are merged into one message so the result alternates user/assistant,
    as the Messages API requires, with tool_use blocks landing in assistant
    messages and tool_result blocks in user messages.
    """
    messages: list[dict] = []
    for event in events:
        converted = _event_to_message(event)
        if converted is not None:
            _append(messages, *converted)
    _append(messages, "user", _text_content(prompt.content))
    return messages


def _append(messages: list[dict], role: str, blocks: list[dict]) -> None:
    if messages and messages[-1]["role"] == role:
        messages[-1]["content"].extend(blocks)
    else:
        messages.append({"role": role, "content": list(blocks)})


def _event_to_message(event: event_pb2.Event) -> tuple[str, list[dict]] | None:
    """An event as (role, content blocks), or None if it carries no known turn."""
    kind = event.WhichOneof("payload")
    if kind == "user_message":
        return "user", _text_content(event.user_message.content)
    if kind == "agent_message":
        return "assistant", _text_content(event.agent_message.content)
    if kind == "agent_tool_use":
        use = event.agent_tool_use
        return "assistant", [
            {
                "type": "tool_use",
                "id": use.id,
                "name": use.name,
                "input": json_format.MessageToDict(use.input),
            }
        ]
    if kind == "agent_tool_result":
        res = event.agent_tool_result
        return "user", [
            {
                "type": "tool_result",
                "tool_use_id": res.tool_use_id,
                "content": _blocks_text(res.content),
                "is_error": res.is_error,
            }
        ]
    return None


def _text_content(blocks: Sequence[event_pb2.ContentBlock]) -> list[dict]:
    """Funky content blocks as Anthropic text content blocks (text only, today)."""
    return [
        {"type": "text", "text": block.text.text}
        for block in blocks
        if block.WhichOneof("block") == "text"
    ]


def _blocks_text(blocks: Sequence[event_pb2.ContentBlock]) -> str:
    """Flatten content blocks to a string, for a tool_result's content."""
    return "".join(
        block.text.text for block in blocks if block.WhichOneof("block") == "text"
    )


def _format_output(result: sandbox_runtime_pb2.ExecCommandResponse) -> str:
    """Combine a command's stdout/stderr, noting a non-zero exit code."""
    parts = [stream for stream in (result.stdout, result.stderr) if stream]
    text = "\n".join(parts)
    if result.exit_code != 0:
        note = f"[exit code {result.exit_code}]"
        text = f"{text}\n{note}" if text else note
    return text


def _agent_text_event(text: str) -> event_pb2.Event:
    """A payload-only AgentMessage Event wrapping a single text block."""
    return event_pb2.Event(
        agent_message=event_pb2.AgentMessage(
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=text))]
        )
    )


def _agent_tool_use_event(block) -> event_pb2.Event:
    """A payload-only AgentToolUse Event for a model tool_use block."""
    use = event_pb2.AgentToolUse(id=block.id, name=block.name)
    if isinstance(block.input, dict):
        use.input.update(block.input)
    return event_pb2.Event(agent_tool_use=use)


def _agent_tool_result_event(
    tool_use_id: str, output: str, is_error: bool
) -> event_pb2.Event:
    """A payload-only AgentToolResult Event for a tool call's outcome."""
    return event_pb2.Event(
        agent_tool_result=event_pb2.AgentToolResult(
            tool_use_id=tool_use_id,
            content=[event_pb2.ContentBlock(text=event_pb2.TextBlock(text=output))],
            is_error=is_error,
        )
    )
