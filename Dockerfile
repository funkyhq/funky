# Dockerfile (repo root) — ONE image for the whole workspace. Runs the api
# by default; the migrate one-shot and the worker are the SAME image with a
# different command (ratified: one image, two commands).
#
# Runs TypeScript via tsx, exactly how the rest of the repo executes it
# (dev, tests, the e2e forking main.ts). Compile-to-dist is a deliberate
# later step for the day image size or cold-start actually matters.

FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first: dependency layers cache until a manifest changes. A
# frozen-lockfile install needs every workspace package's manifest.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/adapters/package.json packages/adapters/

RUN pnpm install --frozen-lockfile

# Then the source (see .dockerignore for what stays out).
COPY . .

EXPOSE 3000

# Default command = api. Compose overrides this for migrate and the worker.
CMD ["pnpm", "-F", "api", "start"]
