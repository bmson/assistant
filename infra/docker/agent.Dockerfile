FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /src
RUN corepack enable

# Manifests first: dependency layers survive source edits, so a one-line code
# change re-runs the build step but not the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/persistence/package.json ./packages/persistence/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/application/package.json ./packages/application/
COPY packages/tools/package.json ./packages/tools/
COPY packages/modules/package.json ./packages/modules/
COPY packages/setup/package.json ./packages/setup/
COPY apps/agent/package.json ./apps/agent/
COPY apps/agent/runtime-dependencies/package.json ./apps/agent/runtime-dependencies/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/agent... --filter @assistant/agent-runtime-dependencies

# The composition file is agent source: it decides which modules are compiled in.
COPY assistant.config.ts ./
COPY packages ./packages
COPY apps/agent ./apps/agent
RUN pnpm --filter @assistant/agent build
RUN pnpm --filter @assistant/agent-runtime-dependencies --prod deploy --legacy /runtime-dependencies

FROM public.ecr.aws/docker/library/node:22-slim AS runtime
# Apply available Debian security updates even when the base image is older.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV ASSISTANT_REPO_ROOT=/app
ARG GIT_SHA=unknown
ENV BUILD_SHA=${GIT_SHA}
WORKDIR /app

COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs ./index.mjs
COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs.map ./index.mjs.map
COPY --from=build --chown=node:node /runtime-dependencies/node_modules ./node_modules

# The tiny locked runtime dependency workspace contains only packages external
# to the ESM bundle. Keep its pnpm virtual store and symlinks intact so Firestore
# can resolve protobuf assets and unpdf can load its worker/WASM files.
# npm is not used at runtime; strip its bundled tree from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "/app/index.mjs"]
