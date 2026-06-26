# Container image for the local Anthropic AgentService, for Docker Compose.
#
# IMPORTANT: build with the REPOSITORY ROOT as the context, not this directory —
# the backend resolves `funky-protos` from the uv workspace (gen/python) and the
# ConnectRPC stubs are generated from proto/ at build time. From the repo root:
#
#   docker build -f agent_service/local_python_anthropic/Dockerfile \
#     -t funky-agent-service-anthropic .
#
# `buf generate` reaches Buf's remote plugins, so the build needs network access.
#
# A turn makes a real, billed call to the Anthropic Messages API, so
# ANTHROPIC_API_KEY must be in the environment, and it execs its tools in a
# SandboxRuntime, reached over HTTP at --sandbox-runtime-url (so this service
# never needs the Docker socket — only the sandbox-runtime does). Both are wired
# up by the agent-service entry in docker-compose.yml.

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

# Generate the stubs, then install just this backend (plus funky-protos) from the
# committed lockfile into /app/.venv. --no-dev drops the test-only deps.
RUN buf generate \
 && uv sync --frozen --no-dev --package funky-agent-service-anthropic

ENV PATH="/app/.venv/bin:$PATH"

# Bind all interfaces so sibling Compose services can reach it. The sandbox URL is
# a CLI flag (no env-var fallback in the server), so Compose passes it through
# SANDBOX_RUNTIME_URL here; ANTHROPIC_API_KEY is read from the environment.
EXPOSE 8083
CMD ["sh", "-c", "funky-agent-service-anthropic --host 0.0.0.0 --port ${PORT:-8083} --sandbox-runtime-url ${SANDBOX_RUNTIME_URL:-http://127.0.0.1:8082}"]
