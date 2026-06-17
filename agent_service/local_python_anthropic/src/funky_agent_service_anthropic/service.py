"""AgentService over the Anthropic-backed agent loop.

Structurally satisfies the generated ``AgentServiceSync`` protocol: ``run_turn``
takes its request plus a ``RequestContext`` and returns a ``RunTurnResponse``. The
loop owns the model call and the sandbox tool calls and produces the Events; this
layer unpacks the request, collects the events into the response, and builds the
default Anthropic client when one isn't injected.
"""

from __future__ import annotations

import anthropic

from connectrpc.request import RequestContext

from funky.agent.v1 import agent_service_pb2 as pb

from .loop import DEFAULT_MAX_TOKENS, AnthropicAgentLoop


class AgentServiceAnthropic:
    """Anthropic-backed ``funky.agent.v1.AgentService``."""

    def __init__(
        self,
        sandbox_client,
        *,
        client: anthropic.Anthropic | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> None:
        # sandbox_client is a SandboxRuntime client the agent execs its tools in.
        # anthropic.Anthropic() reads ANTHROPIC_API_KEY from the environment. Both
        # clients are injectable so tests can drive the turn with a fake model and
        # a fake sandbox instead of the real services (see tests/).
        self._loop = AnthropicAgentLoop(
            client or anthropic.Anthropic(), sandbox_client, max_tokens=max_tokens
        )

    def run_turn(
        self, request: pb.RunTurnRequest, ctx: RequestContext
    ) -> pb.RunTurnResponse:
        events = self._loop.run_turn(
            request.agent_config, request.events, request.prompt, request.sandbox
        )
        return pb.RunTurnResponse(events=events)
