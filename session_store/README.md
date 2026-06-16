# SessionStore backends

Implementations of the [`funky.session.v1.SessionStore`](../proto/funky/session/v1/session_store.proto)
service — create sessions from a resolved agent snapshot and an environment id,
and store and read back their append-only event history.

Each backend lives in its own directory and is an independent, installable
package, so it only declares the dependencies it actually needs. Directories are
named by the three axes that distinguish a backend:

```
<deployment>_<language>_<storage>
```

| Directory | Deployment | Language | Storage |
|---|---|---|---|
| `local_python_jsonl` | local | Python | JSONL files |
| *(future)* `gcp_python_postgres` | GCP (Cloud SQL) | Python | Postgres |

Every backend implements the same wire contract, so the forthcoming **Client**
orchestrator — and any ConnectRPC client — can talk to any of them unchanged.

See each backend's own README to run it.
