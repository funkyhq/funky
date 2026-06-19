"""Serve the Postgres SessionStore as a local ConnectRPC (ASGI) server.

The generated ``SessionStoreASGIApplication`` is async, matching the async store,
so it runs on uvicorn (an ASGI server) rather than the JSONL backend's WSGI/
waitress stack. ConnectRPC speaks HTTP/1.1 + JSON, so the endpoints are also
reachable with plain ``curl`` (see README.md).

The engine is built, the schema ensured, and the server run all inside one event
loop so the Cloud SQL connector and asyncpg connection pool live where they're
used. On shutdown the pool is disposed and the connector closed.
"""

from __future__ import annotations

import argparse
import asyncio

import uvicorn

from funky.session.v1.session_store_connect import SessionStoreASGIApplication

from .db import DatabaseConfig, create_engine
from .service import SessionStoreService
from .store import SqlSessionStore


async def serve(host: str, port: int) -> None:
    config = DatabaseConfig.from_env()
    engine, connector = await create_engine(config)
    try:
        store = SqlSessionStore(engine)
        await store.create_all()

        app = SessionStoreASGIApplication(SessionStoreService(store))
        server = uvicorn.Server(uvicorn.Config(app, host=host, port=port))
        print(
            f"SessionStore (postgres) listening on http://{host}:{port}\n"
            f"  instance: {config.instance_connection_name}\n"
            f"  database: {config.db}",
            flush=True,
        )
        await server.serve()
    finally:
        await engine.dispose()
        await connector.close_async()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    # Defaults off the ConfigRegistry's 8080 so both can run locally at once.
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()
    asyncio.run(serve(args.host, args.port))


if __name__ == "__main__":
    main()
