# Dockerfile (repo root) — ONE image for the api, the migrator and the
# worker, in two stages: compile the three entries with the full toolchain,
# then lay the bundles beside a pruned production install. Runs the api by
# default; the migrate one-shot and the worker are the SAME image with a
# different command (ratified: one image, two commands).
#
# The bundles carry the workspace source (@funky/* is bundled in); npm
# dependencies stay external and come from the prod install — so the
# runtime image ships no TypeScript, no tsx, no dev toolchain.
#
# The console (`--target web`) is the one process that can't live in that
# image — vite serves it, and vite is a dev dependency — so it gets a stage
# of its own. That stage sits in the MIDDLE deliberately: the default target
# is whichever stage comes last, and the default has to stay the api's.

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Manifests first: dependency layers cache until a manifest changes. A
# frozen-lockfile install needs every workspace package's manifest.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/adapters/package.json packages/adapters/

RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The console (apps/web), served by `vite preview`: the built bundle plus
# the dev server's /v1 proxy, which preview reuses as-is (vite resolves
# `preview.proxy ?? server.proxy`). That proxy is why this is a server and
# not a folder of static files — the api has no CORS and is bearer-authed,
# so the console never calls it directly. The token is attached HERE and
# never enters the browser, exactly as in dev (apps/web/vite.config.ts).
#
# The stage IS the build stage: vite is a dev dependency, so there is no
# pruned install to lay a bundle beside. Those layers are already built for
# the stage above, so this target adds nothing to the build — it is a fat
# image by the standard of the two below, and it is a dev console.
#
# `pnpm build` again at START, rather than shipping the bundle the stage
# above already made: WHICH providers the console offers is compiled into
# the bundle from the keys in the environment, and those are runtime
# values. Building here is what lets a key added to .env show up on a plain
# `docker compose up`, with no --build. It costs about three seconds of
# boot — `tsc -b` finds the buildinfo from the image build and no-ops,
# leaving vite's second-long pass.
FROM build AS web
EXPOSE 5173
CMD ["sh", "-c", "pnpm --filter web run build && exec pnpm --filter web run preview --host --port 5173"]

FROM node:22-slim
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
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
