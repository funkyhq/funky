# Dockerfile (repo root) — ONE image for the whole workspace.
# Runs the api by default; the worker is the SAME image with a different command
# (the "one image, two Deployments" decision, honored from the first build).
#
# Honest status: this runs TypeScript via tsx — correct and fine for the compose
# quickstart. Production hardening (tsc → dist, pruned prod-only deps via
# `pnpm deploy`, distroless base) is a deliberate later step.

FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first: dependency layers cache until a package.json/lockfile changes.
# EVERY workspace package's manifest is needed — a frozen-lockfile install fails if any
# package referenced by the lockfile is missing. (api → sessions → llm/sandbox/configs;
# worker → the same graph.)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/configs/package.json packages/configs/
COPY packages/sessions/package.json packages/sessions/
COPY packages/ports/llm/package.json packages/ports/llm/
COPY packages/ports/sandbox/package.json packages/ports/sandbox/

RUN pnpm install --frozen-lockfile

# Then the source (see .dockerignore for what stays out).
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Default command = api. Compose overrides this for the migrate one-shot and the worker.
CMD ["pnpm", "-F", "api", "start:src"]
