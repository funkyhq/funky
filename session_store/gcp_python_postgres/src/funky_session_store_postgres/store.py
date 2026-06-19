"""Async, ORM-backed persistence for sessions and their event history.

``SqlSessionStore`` wraps a SQLAlchemy :class:`AsyncEngine` and speaks the same
contract as the JSONL backend's store, one method per RPC. It is engine-agnostic
— the Cloud SQL + asyncpg wiring lives in :mod:`db`, and the hermetic tests point
it at SQLite — so this layer is just proto↔row mapping and ORM queries.

Sessions are write-once and events are append-only; nothing is mutated in place.
The mapping is symmetric with :mod:`models`: scalar fields ride in columns, the
nested ``AgentConfig`` and Event ``payload`` oneof ride in JSON columns.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from google.protobuf import json_format
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from funky.type.v1 import agent_pb2, event_pb2, session_pb2

from .models import Base, EventRow, SessionRow

# Event scalar fields the store owns; cleared before capturing the payload oneof
# so a JSON column holds only the discriminated payload, not the metadata.
_EVENT_META_FIELDS = ("id", "session_id", "processed_at")


class SqlSessionStore:
    """Sessions and their events, persisted via SQLAlchemy ORM over Postgres."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._session = async_sessionmaker(engine, expire_on_commit=False)

    async def create_all(self) -> None:
        """Create the ``sessions`` and ``events`` tables if they don't exist."""
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def create_session(
        self, agent_config: agent_pb2.AgentConfig, environment_config_id: str
    ) -> session_pb2.Session:
        """Mint an id, persist the session, and return the stored record."""
        session = session_pb2.Session(
            id=f"ses_{uuid.uuid4().hex}",
            agent_config=agent_config,
            environment_config_id=environment_config_id,
        )
        async with self._session.begin() as db:
            db.add(_to_session_row(session))
        return session

    async def get_session(self, session_id: str) -> session_pb2.Session | None:
        """Return the session with ``session_id``, or ``None`` if absent."""
        async with self._session() as db:
            row = await db.get(SessionRow, session_id)
            return _to_session(row) if row is not None else None

    async def append_event(
        self, session_id: str, event: event_pb2.Event
    ) -> event_pb2.Event | None:
        """Append ``event`` to ``session_id``'s history and return the stored copy.

        The stored copy is assigned a fresh id, the ``session_id``, and a
        ``processed_at`` timestamp; the caller's payload is preserved as-is.
        Returns ``None`` if no such session exists — the existence check and the
        insert share one transaction, and sessions are never deleted, so the
        session can't vanish between them.
        """
        stored = event_pb2.Event()
        stored.CopyFrom(event)
        stored.id = f"evt_{uuid.uuid4().hex}"
        stored.session_id = session_id
        stored.processed_at.GetCurrentTime()
        async with self._session.begin() as db:
            if await db.get(SessionRow, session_id) is None:
                return None
            db.add(_to_event_row(stored))
        return stored

    async def list_events(
        self, session_id: str
    ) -> list[event_pb2.Event] | None:
        """Return ``session_id``'s events in append order.

        Returns ``None`` if no such session exists, distinct from an existing
        session with no events yet (an empty list).
        """
        async with self._session() as db:
            if await db.get(SessionRow, session_id) is None:
                return None
            rows = await db.scalars(
                select(EventRow)
                .where(EventRow.session_id == session_id)
                .order_by(EventRow.seq)
            )
            return [_to_event(row) for row in rows]


# --- proto <-> row mapping ---------------------------------------------------


def _to_session_row(session: session_pb2.Session) -> SessionRow:
    return SessionRow(
        id=session.id,
        agent_config=json_format.MessageToDict(
            session.agent_config, preserving_proto_field_name=True
        ),
        environment_config_id=session.environment_config_id,
    )


def _to_session(row: SessionRow) -> session_pb2.Session:
    session = session_pb2.Session(
        id=row.id, environment_config_id=row.environment_config_id
    )
    json_format.ParseDict(row.agent_config, session.agent_config)
    return session


def _to_event_row(event: event_pb2.Event) -> EventRow:
    payload = event_pb2.Event()
    payload.CopyFrom(event)
    for field in _EVENT_META_FIELDS:
        payload.ClearField(field)
    return EventRow(
        id=event.id,
        session_id=event.session_id,
        processed_at=event.processed_at.ToDatetime(tzinfo=timezone.utc),
        payload=json_format.MessageToDict(payload, preserving_proto_field_name=True),
    )


def _to_event(row: EventRow) -> event_pb2.Event:
    event = event_pb2.Event()
    json_format.ParseDict(row.payload, event)
    event.id = row.id
    event.session_id = row.session_id
    # SQLite hands back a naive datetime; treat it as the UTC it was stored as.
    processed_at = row.processed_at
    if processed_at.tzinfo is None:
        processed_at = processed_at.replace(tzinfo=timezone.utc)
    event.processed_at.FromDatetime(processed_at)
    return event
