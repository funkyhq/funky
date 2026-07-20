# Dockerfile (repo root) — ONE image for the whole workspace.
# Runs the api by default; the worker is the SAME image with a different command
# (the "one image, two Deployments" decision, honored from the first build).
#
# Honest status: this runs TypeScript via tsx — correct and fine for the compose
# quickstart. Production hardening (tsc → dist, pruned prod-only deps via
# `pnpm deploy`, distroless base) is a deliberate later step.

FROM node:22-slim

# The Docker CLI (client only, no daemon) — the worker's default `docker` sandbox driver
# shells out to it, talking to the HOST daemon through a mounted /var/run/docker.sock (see
# docker-compose.yml). Grabbed from the official multi-arch `docker` image; the api never
# uses it, but this is the one shared image (api + worker), so it lives here.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first: dependency layers cache until a package.json/lockfile changes.
# EVERY workspace package's manifest is needed — a frozen-lockfile install fails if any
# package referenced by the lockfile is missing. (api → sessions → llm/sandbox/configs;
# worker → the same graph; web is the Vite console served by the `web` compose service.)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/configs/package.json packages/configs/
COPY packages/sessions/package.json packages/sessions/
COPY packages/ports/harness/package.json packages/ports/harness/
COPY packages/ports/llm/package.json packages/ports/llm/
COPY packages/ports/sandbox/package.json packages/ports/sandbox/

RUN pnpm install --frozen-lockfile

# Then the source (see .dockerignore for what stays out).
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Default command = api. Compose overrides this for the migrate one-shot and the worker.
CMD ["pnpm", "-F", "api", "start:src"]
