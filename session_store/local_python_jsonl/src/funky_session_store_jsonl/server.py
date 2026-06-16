"""Serve the JSONL SessionStore as a local ConnectRPC server.

Wraps the service in the generated WSGI application and runs it on waitress — a
pure-Python, fully local WSGI server. (The stdlib ``wsgiref`` server is not used:
it hands the app the raw, unbounded socket as ``wsgi.input``, which deadlocks
connect-python's error path when it drains the request body.) ConnectRPC speaks
HTTP/1.1 + JSON here, so the endpoints are also reachable with plain ``curl``
(see README.md).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from waitress.server import create_server

from funky.session.v1.session_store_connect import SessionStoreWSGIApplication

from .service import SessionStoreService


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    # Defaults off the ConfigRegistry's 8080 so both can run locally at once.
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("./data"),
        help="directory for sessions.jsonl and events.jsonl",
    )
    args = parser.parse_args()

    service = SessionStoreService(args.data_dir)
    app = SessionStoreWSGIApplication(service)

    server = create_server(app, host=args.host, port=args.port)
    host, port = server.socket.getsockname()[:2]
    print(
        f"SessionStore (jsonl) listening on http://{host}:{port}\n"
        f"  data dir: {args.data_dir.resolve()}",
        flush=True,
    )
    server.run()


if __name__ == "__main__":
    main()
