# Container image for the FunkyClient HTTP server, for Cloud Run.
#
# IMPORTANT: build with the REPOSITORY ROOT as the context, not this directory —
# the client resolves `funky-protos` from the uv workspace (gen/python) and the
# ConnectRPC stubs are generated from proto/ at build time. From the repo root:
#
#   docker build -f client/gcp_python/Dockerfile \
#     --platform linux/amd64 -t funky-client .
#
# `buf generate` reaches Buf's remote plugins, so the build needs network access.

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

# Generate the stubs, then install just the client with its `server` extra (the
# HTTP stack) plus funky-protos from the committed lockfile into /app/.venv.
# --no-dev drops the test-only deps; the `local` extra (the in-process backends)
# is left out — this image only runs the HTTP front door.
RUN buf generate \
 && uv sync --frozen --no-dev --extra server --package funky-client

ENV PATH="/app/.venv/bin:$PATH"

# Cloud Run routes requests to $PORT (default 8080); the server must bind all
# interfaces. The four backend URLs are supplied as Cloud Run env vars at deploy
# time (CONFIG_REGISTRY_URL / SESSION_STORE_URL / SANDBOX_RUNTIME_URL /
# AGENT_SERVICE_URL); each falls back to a localhost default if unset.
EXPOSE 8080
CMD ["sh", "-c", "funky-client-server --host 0.0.0.0 --port ${PORT:-8080}"]
