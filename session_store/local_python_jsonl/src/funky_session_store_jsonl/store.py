"""Append-only JSONL persistence for sessions and their event history.

Two files share one directory:

  - ``sessions.jsonl`` — one line per session
  - ``events.jsonl``   — one line per appended event, in append order

Each line is the proto3 JSON form of the message itself. Session and Event both
carry their own id (unlike the ConfigRegistry's pure-spec configs, which need an
``{"id": ..., "config": {...}}`` envelope), so the record *is* the message — its
id field is the lookup key. Sessions are write-once and events are append-only;
nothing is ever mutated in place.
"""

from __future__ import annotations

import json
import uuid
import threading
from pathlib import Path

from google.protobuf import json_format
from google.protobuf.message import Message

from funky.type.v1 import agent_pb2, event_pb2, session_pb2


class JsonlSessionStore:
    """Sessions and their events, persisted as two append-only JSONL files."""

    def __init__(self, data_dir: Path) -> None:
        self._sessions_path = data_dir / "sessions.jsonl"
        self._events_path = data_dir / "events.jsonl"
        # One lock guards both files: append_event reads sessions.jsonl to check
        # the session exists and then writes events.jsonl, and that read+write
        # pair must not interleave with a concurrent create on the threaded WSGI
        # server.
        self._lock = threading.Lock()
        data_dir.mkdir(parents=True, exist_ok=True)
        self._sessions_path.touch(exist_ok=True)
        self._events_path.touch(exist_ok=True)

    def create_session(
        self, agent_config: agent_pb2.AgentConfig, environment_config_id: str
    ) -> session_pb2.Session:
        """Mint an id, persist the session, and return the stored record."""
        session = session_pb2.Session(
            id=f"ses_{uuid.uuid4().hex}",
            agent_config=agent_config,
            environment_config_id=environment_config_id,
        )
        with self._lock:
            self._append(self._sessions_path, session)
        return session

    def get_session(self, session_id: str) -> session_pb2.Session | None:
        """Return the session with ``session_id``, or ``None`` if absent."""
        with self._lock:
            for record in self._records(self._sessions_path):
                if record.get("id") == session_id:
                    return json_format.ParseDict(record, session_pb2.Session())
        return None

    def append_event(
        self, session_id: str, event: event_pb2.Event
    ) -> event_pb2.Event | None:
        """Append ``event`` to ``session_id``'s history and return the stored copy.

        The stored copy is assigned a fresh id, the ``session_id``, and a
        ``processed_at`` timestamp; the caller's payload is preserved as-is.
        Returns ``None`` if no such session exists — checked under the lock so a
        session can't be removed between the check and the append (it never is
        today, but the invariant is cheap to hold).
        """
        stored = event_pb2.Event()
        stored.CopyFrom(event)
        stored.id = f"evt_{uuid.uuid4().hex}"
        stored.session_id = session_id
        stored.processed_at.GetCurrentTime()
        with self._lock:
            if not self._contains(self._sessions_path, session_id):
                return None
            self._append(self._events_path, stored)
        return stored

    def list_events(self, session_id: str) -> list[event_pb2.Event] | None:
        """Return ``session_id``'s events in append order.

        Returns ``None`` if no such session exists, distinct from an existing
        session with no events yet (an empty list).
        """
        with self._lock:
            if not self._contains(self._sessions_path, session_id):
                return None
            return [
                json_format.ParseDict(record, event_pb2.Event())
                for record in self._records(self._events_path)
                if record.get("session_id") == session_id
            ]

    @staticmethod
    def _append(path: Path, message: Message) -> None:
        record = json_format.MessageToDict(
            message, preserving_proto_field_name=True
        )
        line = json.dumps(record, separators=(",", ":"))
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    @staticmethod
    def _records(path: Path) -> list[dict]:
        """All records in ``path``, in file (append) order. Caller holds the lock."""
        with path.open("r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _contains(self, path: Path, record_id: str) -> bool:
        return any(record.get("id") == record_id for record in self._records(path))
