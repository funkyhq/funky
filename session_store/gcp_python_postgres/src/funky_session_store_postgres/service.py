"""SessionStore service implementation over a Postgres-backed store.

Structurally satisfies the generated async ``SessionStore`` protocol: each RPC is
a coroutine taking its request message plus a ``RequestContext`` and returning
its response message. The store owns sessions and their append-only event
history; this layer maps absent sessions to NOT_FOUND.
"""

from __future__ import annotations

from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.request import RequestContext

from funky.session.v1 import session_store_pb2 as pb

from .store import SqlSessionStore


class SessionStoreService:
    """Postgres-backed ``funky.session.v1.SessionStore``."""

    def __init__(self, store: SqlSessionStore) -> None:
        self._store = store

    async def create_session(
        self, request: pb.CreateSessionRequest, ctx: RequestContext
    ) -> pb.CreateSessionResponse:
        session = await self._store.create_session(
            request.agent_config, request.environment_config_id
        )
        return pb.CreateSessionResponse(session=session)

    async def get_session(
        self, request: pb.GetSessionRequest, ctx: RequestContext
    ) -> pb.GetSessionResponse:
        session = await self._store.get_session(request.id)
        if session is None:
            raise ConnectError(Code.NOT_FOUND, f"session {request.id!r} not found")
        return pb.GetSessionResponse(session=session)

    async def append_event(
        self, request: pb.AppendEventRequest, ctx: RequestContext
    ) -> pb.AppendEventResponse:
        event = await self._store.append_event(request.session_id, request.event)
        if event is None:
            raise ConnectError(
                Code.NOT_FOUND, f"session {request.session_id!r} not found"
            )
        return pb.AppendEventResponse(event=event)

    async def list_events(
        self, request: pb.ListEventsRequest, ctx: RequestContext
    ) -> pb.ListEventsResponse:
        events = await self._store.list_events(request.session_id)
        if events is None:
            raise ConnectError(
                Code.NOT_FOUND, f"session {request.session_id!r} not found"
            )
        return pb.ListEventsResponse(events=events)
