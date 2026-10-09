# The Workspace code-execution job (Cloud Run Job, Phase 13). The supervisor
# has only per-run CODE_JOB_INPUT and its least-privileged service identity;
# model-authored code must run through the Cloud Run sandbox launcher. The
# sandbox gets no parent environment or metadata access and denies egress by
# default. The launcher is enabled on the Cloud Run Job deployment.

# Resolve workspace dependencies in a throwaway build stage and copy only the
# production deployment into the image. Development TypeScript/esbuild binaries
# and Vitest never enter the final filesystem.
FROM node:22-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/code-runner ./workers/code-runner
COPY packages/persistence ./packages/persistence
RUN pnpm install --frozen-lockfile --filter @assistant/code-runner... \
  && pnpm --filter @assistant/code-runner deploy --prod --legacy /runtime

FROM node:22-slim
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
# Data-analysis toolkit, installed at BUILD time (the runtime has no egress).
# Pinned for reproducibility; matplotlib uses the headless Agg backend by default.
RUN pip install --no-cache-dir --break-system-packages \
  numpy==2.1.3 \
  pandas==2.2.3 \
  matplotlib==3.9.2 \
  openpyxl==3.1.5
COPY --from=build /runtime ./
RUN groupadd --system coderun && useradd --system --gid coderun --create-home coderun \
  && chown -R coderun:coderun /app /home/coderun
ENV NODE_ENV=production
# No package manager is used at runtime; omit its unused vendored dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node
USER coderun
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
