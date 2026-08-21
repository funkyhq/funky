# Dockerfile (repo root) — ONE image for the whole workspace, in two
# stages: compile the three entries with the full toolchain, then lay the
# bundles beside a pruned production install. Runs the api by default;
# the migrate one-shot and the worker are the SAME image with a different
# command (ratified: one image, two commands).
#
# The bundles carry the workspace source (@funky/* is bundled in); npm
# dependencies stay external and come from the prod install — so the
# runtime image ships no TypeScript, no tsx, no dev toolchain.

FROM node:22-slim AS build
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
COPY . .
RUN pnpm build

FROM node:22-slim
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/adapters/package.json packages/adapters/

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/adapters/dist packages/adapters/dist
# The migrator resolves the SQL beside its bundle (../../migrations).
COPY packages/adapters/migrations packages/adapters/migrations

EXPOSE 3000

# Default command = api. Compose overrides this for migrate and the worker.
CMD ["node", "apps/api/dist/main.mjs"]
