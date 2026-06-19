"""Build a SQLAlchemy async engine backed by Cloud SQL + asyncpg.

The Cloud SQL Python Connector dials the instance over a secure tunnel — no
public IP allowlisting or local proxy sidecar — and hands SQLAlchemy a live
``asyncpg`` connection through ``create_async_engine``'s ``async_creator`` hook.
See https://github.com/GoogleCloudPlatform/cloud-sql-python-connector.

The connector and the engine share a lifetime: dispose the engine, then close
the connector. :func:`create_engine` returns both so the caller can do exactly
that on shutdown.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from google.cloud.sql.connector import Connector, IPTypes, create_async_connector
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


@dataclass(frozen=True)
class DatabaseConfig:
    """Everything needed to reach a Cloud SQL Postgres instance.

    ``password`` is unused when ``iam_auth`` is set: IAM database authentication
    mints a short-lived token from the connector's ambient credentials instead.
    """

    instance_connection_name: str  # "project:region:instance"
    user: str
    db: str
    password: str = ""
    ip_type: IPTypes = IPTypes.PUBLIC
    iam_auth: bool = False

    @classmethod
    def from_env(cls) -> "DatabaseConfig":
        """Read the config from ``INSTANCE_CONNECTION_NAME`` / ``DB_*`` env vars."""
        return cls(
            instance_connection_name=_require_env("INSTANCE_CONNECTION_NAME"),
            user=_require_env("DB_USER"),
            db=_require_env("DB_NAME"),
            password=os.environ.get("DB_PASS", ""),
            # IPTypes is keyed by name (PUBLIC/PRIVATE/PSC), distinct from its
            # wire values ("PRIMARY"/...), so map the friendly env string by name.
            ip_type=IPTypes[os.environ.get("DB_IP_TYPE", "public").upper()],
            iam_auth=os.environ.get("DB_IAM_AUTH", "").lower() in ("1", "true", "yes"),
        )


async def create_engine(
    config: DatabaseConfig,
) -> tuple[AsyncEngine, Connector]:
    """Return an ``(engine, connector)`` pair wired to ``config``.

    The engine opens connections lazily, so this only fails fast on bad config;
    a genuine connection error surfaces on first use (table creation at startup).
    """
    connector = await create_async_connector()

    async def connect():
        return await connector.connect_async(
            config.instance_connection_name,
            "asyncpg",
            user=config.user,
            password=config.password,
            db=config.db,
            ip_type=config.ip_type,
            enable_iam_auth=config.iam_auth,
        )

    engine = create_async_engine("postgresql+asyncpg://", async_creator=connect)
    return engine, connector


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing required environment variable: {name}")
    return value
