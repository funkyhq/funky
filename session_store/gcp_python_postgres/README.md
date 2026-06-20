# gcp_python_postgres

A [`SessionStore`](../../proto/funky/session/v1/session_store.proto) backed by a
**GCP Cloud SQL (Postgres)** database. It reaches the instance through the
[Cloud SQL Python Connector](https://github.com/GoogleCloudPlatform/cloud-sql-python-connector)
with the async [`asyncpg`](https://github.com/MagicStack/asyncpg) driver, and
maps rows with the [SQLAlchemy](https://www.sqlalchemy.org/) ORM for readability.

Two tables mirror the JSONL backend's two files:

- `sessions` — one row per session: its `ses_` id, the snapshotted `AgentConfig`
  (as `JSONB`), and the `environment_config_id`.
- `events` — one row per appended event: a database-assigned `seq` for append
  order, the `evt_` id, the owning `session_id`, `processed_at`, and the event
  `payload` oneof (as `JSONB`).

`CreateSession` snapshots the resolved agent config into a new session, mints a
`ses_` id, and returns it; `GetSession` resolves an id back. `AppendEvent`
appends an event — the store assigns the `evt_` id, `session_id`, and a
`processed_at` timestamp on the stored copy, preserving the caller's payload;
`ListEvents` reads a session's events back in append order (`ORDER BY seq`).

The server is async end to end: the generated `SessionStoreASGIApplication`
served on [uvicorn](https://www.uvicorn.org/), an async store over a SQLAlchemy
async engine, and asyncpg under the connector.

## Configure

The server reads the Cloud SQL connection from the environment:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `INSTANCE_CONNECTION_NAME` | yes | — | `project:region:instance` |
| `DB_USER` | yes | — | database user |
| `DB_NAME` | yes | — | database name |
| `DB_PASS` | no | _(empty)_ | password (omit when using IAM auth) |
| `DB_IP_TYPE` | no | `public` | `public`, `private`, or `psc` |
| `DB_IAM_AUTH` | no | `false` | use IAM database authentication |

The connector authenticates with [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials),
so `gcloud auth application-default login` (or a service-account key /
Workload Identity in deployment) must be in place.

## Run it

From the repository root:

```bash
buf generate            # regenerate the protobuf/ConnectRPC stubs into gen/python
uv sync                 # create the workspace venv and install the backend + deps

gcloud auth application-default login   # credentials for the Cloud SQL connector

export INSTANCE_CONNECTION_NAME="my-project:us-central1:my-instance"
export DB_USER="funky" DB_NAME="funky" DB_PASS="..."
uv run funky-session-store-postgres --port 8081
```

It speaks ConnectRPC over HTTP/1.1 + JSON, so you can poke it with `curl` (proto3
JSON uses camelCase field names, e.g. `agentConfig`, `environmentConfigId`,
`sessionId`, `userMessage`):

```bash
# Create a session -> {"session":{"id":"ses_...", ...}}
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/CreateSession \
  -H 'Content-Type: application/json' \
  -d '{"agentConfig":{"name":"researcher","model":"gemini-3.5-flash","systemPrompt":"You are a careful research assistant."},"environmentConfigId":"env_local"}'

# Resolve it back
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/GetSession \
  -H 'Content-Type: application/json' -d '{"id":"ses_..."}'

# Append a user-message event -> the stored event, with id and processedAt set
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/AppendEvent \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"ses_...","event":{"userMessage":{"content":[{"text":{"text":"hello"}}]}}}'

# Read the session's history, in append order
curl -X POST http://127.0.0.1:8081/funky.session.v1.SessionStore/ListEvents \
  -H 'Content-Type: application/json' -d '{"sessionId":"ses_..."}'
```

## Test

```bash
uv run pytest session_store/gcp_python_postgres
```

The test boots the server on an ephemeral port and drives it through the
generated ConnectRPC client, covering the session round trip, appending and
listing events (in order, scoped per session), and the NOT_FOUND paths. Because
the ORM is engine-agnostic it runs against an **in-process SQLite** database by
default — no Cloud SQL instance needed. To run the identical suite against a real
Postgres, point it at a disposable async URL:

```bash
FUNKY_SESSION_STORE_TEST_DATABASE_URL="postgresql+asyncpg://user:pass@localhost/funky_test" \
  uv run pytest session_store/gcp_python_postgres
```

## Deploy to Cloud Run

The [`Dockerfile`](./Dockerfile) builds a self-contained image: it runs
`buf generate` and installs this backend from the committed lockfile, then serves
on `$PORT` bound to all interfaces (Cloud Run's contract).

> **The build context must be the repository root, not this directory.** The
> backend resolves `funky-protos` from the uv workspace, and `buf generate` reads
> `buf.gen.yaml`, `buf.yaml`, and `proto/` — all at the repo root. Building with
> the package directory as the context fails with
> `read buf.gen.yaml: file does not exist`.

**Cloud Build / Cloud Run trigger** — [`cloudbuild.yaml`](./cloudbuild.yaml) is the
config a Cloud Run continuous-deployment trigger generates (build → push to
Artifact Registry → deploy), with one fix: the Docker build context is the
repository root (`.`), not the package directory. The `_AR_*`, `_SERVICE_NAME`,
and `_DEPLOY_REGION` substitutions carry defaults in the file and are set by the
trigger; `$REPO_NAME` / `$COMMIT_SHA` are Cloud Build built-ins. To run it by
hand from the repository root, supply the built-ins the trigger would inject:

```bash
gcloud builds submit \
  --config session_store/gcp_python_postgres/cloudbuild.yaml \
  --substitutions=REPO_NAME=funky,COMMIT_SHA=manual
```

**Or build locally** and push (Cloud Run is linux/amd64):

```bash
# From the repository root.
IMAGE="REGION-docker.pkg.dev/PROJECT/REPO/funky-session-store-postgres"
docker build -f session_store/gcp_python_postgres/Dockerfile --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

Then deploy the image:

```bash
gcloud run deploy funky-session-store-postgres \
  --image "$IMAGE" --region REGION \
  --service-account funky-runtime@PROJECT.iam.gserviceaccount.com \
  --set-env-vars INSTANCE_CONNECTION_NAME=PROJECT:REGION:INSTANCE,DB_USER=funky,DB_NAME=funky \
  --set-secrets DB_PASS=funky-db-pass:latest
```

The connector authenticates as the Cloud Run service account, so grant it
`roles/cloudsql.client` — no `gcloud auth ...` and no Cloud SQL proxy sidecar are
needed. For IAM database auth, drop `DB_PASS` and set `DB_IAM_AUTH=true`. For a
private-IP instance, set `DB_IP_TYPE=private` and give the service [Direct VPC
egress](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc) (or a
Serverless VPC Access connector) onto the instance's network.
