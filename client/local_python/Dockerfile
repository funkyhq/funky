# Container image for the local FunkyClient REST front door, for Docker Compose.
#
# IMPORTANT: build with the REPOSITORY ROOT as the context, not this directory —
# the client resolves `funky-protos` from the uv workspace (gen/python) and the
# ConnectRPC stubs are generated from proto/ at build time. From the repo root:
#
#   docker build -f client/local_python/Dockerfile -t funky-client-local .
#
# `buf generate` reaches Buf's remote plugins, so the build needs network access.
# This is the only service that needs publishing to the host; it fans out to the
# four backends, whose URLs it reads from the environment (see docker-compose.yml).

FROM python:3.12-slim

# uv for locked, reproducible dependency installation.
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /bin/

# buf, to generate the *_pb2 / *_connect stubs from proto/ at build time (they're
# gitignored — the .proto files are the source of truth).
ARG BUF_VERSION=1.70.0
ARG TARGETARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && buf_arch="$(case "$TARGETARCH" in arm64) echo aarch64 ;; *) echo x86_64 ;; esac)" \
 && curl -fsSL "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-${buf_arch}" \
      -o /usr/local/bin/buf \
 && chmod +x /usr/local/bin/buf \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Generate the stubs, then install just the client (plus funky-protos) from the
# committed lockfile into /app/.venv. --no-dev drops the test-only deps. Unlike
# the gcp variant, the REST stack (starlette + uvicorn) is a hard dependency, so
# there is no `server` extra to select.
RUN buf generate \
 && uv sync --frozen --no-dev --package funky-client-local

ENV PATH="/app/.venv/bin:$PATH"

# Bind all interfaces so the published port reaches it. The four backend URLs come
# from the environment (CONFIG_REGISTRY_URL / SESSION_STORE_URL /
# SANDBOX_RUNTIME_URL / AGENT_SERVICE_URL); each falls back to a localhost default.
EXPOSE 8000
CMD ["sh", "-c", "funky-client-local-server --host 0.0.0.0 --port ${PORT:-8000}"]
