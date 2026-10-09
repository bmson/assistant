FROM public.ecr.aws/docker/library/node:22-slim
ENV NODE_ENV=development
ENV ASSISTANT_REPO_ROOT=/app
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/*

# Manifests first: dependency layers survive source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/persistence/package.json ./packages/persistence/
COPY packages/db/package.json ./packages/db/
COPY packages/firestore/package.json ./packages/firestore/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/db... --filter @assistant/firestore...

COPY packages/config ./packages/config
COPY packages/persistence ./packages/persistence
COPY packages/db ./packages/db
COPY packages/firestore ./packages/firestore
COPY infra/docker/database-admin.sh ./infra/docker/database-admin.sh
RUN chown -R node:node /app /opt/corepack
# Runtime uses the pnpm version cached during the build. The migration job has
# no reason to download a package manager when it starts, and its short task
# timeout must not be spent waiting for registry access.
ENV COREPACK_ENABLE_NETWORK=0
# Strip the base image's bundled npm so its vendored dependencies do not ship
# or fail the deploy vulnerability scan. Corepack's shared cache remains under
# /opt/corepack, readable by the runtime user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node
USER node
RUN pnpm --version
CMD ["pnpm", "--filter", "@assistant/db", "reconcile"]
