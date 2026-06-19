"""SQLAlchemy ORM models for sessions and their append-only event history.

Two tables, mirroring the JSONL backend's two files:

  - ``sessions`` — one row per session
  - ``events``   — one row per appended event

Each proto message is stored *decomposed* into readable columns: the scalar
fields the store queries on (ids, ``environment_config_id``, ``processed_at``)
become real columns, and the nested proto sub-messages — the snapshotted
``AgentConfig`` and the Event ``payload`` oneof — are kept as their proto3-JSON
form in ``JSONB`` columns. That keeps the schema legible while round-tripping the
proto without a field-by-field mapping that would drift as the protos grow.

The ``JSONB`` columns degrade to plain ``JSON`` on non-Postgres engines (the
hermetic SQLite test path); production runs Postgres and gets real ``JSONB``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

# JSONB on Postgres, ordinary JSON everywhere else (e.g. SQLite under test).
JsonDict = JSON().with_variant(JSONB, "postgresql")


class Base(DeclarativeBase):
    """Declarative base for the SessionStore schema."""


class SessionRow(Base):
    """A session: a ``ses_`` id, a snapshotted agent, and an environment ref."""

    __tablename__ = "sessions"

    # The ``ses_`` identifier, assigned by the store on create.
    id: Mapped[str] = mapped_column(String, primary_key=True)
    # AgentConfig snapshotted at creation, as proto3 JSON.
    agent_config: Mapped[dict[str, Any]] = mapped_column(JsonDict)
    # EnvironmentConfig reference, by ConfigRegistry id.
    environment_config_id: Mapped[str] = mapped_column(String)

    events: Mapped[list["EventRow"]] = relationship(
        back_populates="session", order_by="EventRow.seq"
    )


class EventRow(Base):
    """One entry in a session's history.

    ``seq`` is a database-assigned, monotonically increasing identity used purely
    to recover append order within a session — ``ORDER BY seq`` is the append
    order. The event's own ``evt_`` id is stored as a unique column, and the
    payload oneof is kept as proto3 JSON.
    """

    __tablename__ = "events"

    # Append-order key, assigned by the database on insert. BigInteger gives
    # BIGSERIAL on Postgres; the SQLite variant is plain INTEGER so it aliases
    # ROWID and autoincrements (SQLite won't autoincrement a BIGINT primary key).
    seq: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    # The ``evt_`` identifier, assigned by the store on append.
    id: Mapped[str] = mapped_column(String, unique=True)
    # Owning session; events are read back scoped to it.
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id"), index=True
    )
    # When the store recorded the event.
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # The Event ``payload`` oneof (e.g. ``{"user_message": {...}}``) as proto3 JSON.
    payload: Mapped[dict[str, Any]] = mapped_column(JsonDict)

    session: Mapped[SessionRow] = relationship(back_populates="events")
