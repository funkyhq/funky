# Container image for the local Docker SandboxRuntime, for Docker Compose.
#
# IMPORTANT: build with the REPOSITORY ROOT as the context, not this directory —
# the backend resolves `funky-protos` from the uv workspace (gen/python) and the
# ConnectRPC stubs are generated from proto/ at build time. From the repo root:
#
#   docker build -f sandbox_runtime/local_python_docker/Dockerfile \
#     -t funky-sandbox-runtime-docker .
#
# `buf generate` reaches Buf's remote plugins, so the build needs network access.
#
# This backend talks to a Docker daemon (via the SDK's docker.from_env(), which
# honours DOCKER_HOST) and spawns each sandbox as a sibling container. In Compose
# it gets the host daemon's socket bind-mounted (Docker-out-of-Docker) — see the
# sandbox-runtime service in docker-compose.yml. The image ships no docker CLI;
# the Python SDK speaks to the daemon over the socket directly.

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
 && uv sync --frozen --no-dev --package funky-sandbox-runtime-docker

ENV PATH="/app/.venv/bin:$PATH"

# Bind all interfaces so sibling Compose services can reach it. --image is the
# base image sandboxes are created from (must contain bash for the agent's tool);
# the default python:3.12-slim does.
EXPOSE 8082
CMD ["sh", "-c", "funky-sandbox-runtime-docker --host 0.0.0.0 --port ${PORT:-8082} --image ${SANDBOX_IMAGE:-python:3.12-slim}"]
