# The Workspace code-execution job (Cloud Run Job, Phase 13). The supervisor
# has only per-run CODE_JOB_INPUT and its least-privileged service identity;
# model-authored code must run through the Cloud Run sandbox launcher. The
# sandbox gets no parent environment or metadata access and denies egress by
# default. The launcher is enabled on the Cloud Run Job deployment.
FROM node:22-slim
WORKDIR /app

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 \
  && rm -rf /var/lib/apt/lists/*

# Data-analysis toolkit, installed at BUILD time (the runtime has no egress).
# Pinned for reproducibility; matplotlib uses the headless Agg backend by default.
RUN pip install --no-cache-dir --break-system-packages \
  numpy==2.1.3 \
  pandas==2.2.3 \
  matplotlib==3.9.2 \
  openpyxl==3.1.5

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/code-runner ./workers/code-runner
COPY packages/persistence ./packages/persistence

RUN pnpm install --frozen-lockfile --filter @assistant/code-runner...

RUN groupadd --system coderun && useradd --system --gid coderun --create-home coderun \
  && chown -R coderun:coderun /app /home/coderun

# Runtime uses pnpm via corepack, never npm. Strip the base image's bundled npm
# so its vendored deps (tar/sigstore/brace-expansion/picomatch, all HIGH/
# CRITICAL) don't ship or fail the deploy vulnerability scan. Also strip the
# corepack download cache the root-run install left under /root: the runtime
# user can't read /root (mode 700) — corepack resolves its own per-user cache —
# so the copy is dead weight that only feeds pnpm advisories to the scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node

ENV NODE_ENV=production
USER coderun
CMD ["pnpm", "--filter", "@assistant/code-runner", "start"]
