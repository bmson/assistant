# The Workspace browser job (Cloud Run Job). Credential-free: no DB URL, no
# API keys — only PROFILE_ENC_KEY (Secret Manager) and per-run BROWSER_JOB_INPUT.

# Build the workspace dependency graph, then deploy only this worker's production
# dependencies. The root development install (TypeScript, test tools, old esbuild)
# is confined to this stage and is not copied into the image.
FROM node:22-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/browser-job ./workers/browser-job
# Legacy deploy resolves root workspace links even for a filtered worker.
# These build-only packages are excluded from the production runtime copy.
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @assistant/browser-job... \
  && pnpm --filter @assistant/browser-job deploy --prod --legacy /runtime

# Chromium and its matched Playwright package are installed in the final image.
FROM node:22-slim
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /runtime ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  NODE_ENV=production \
  CHROMIUM_SANDBOX=true \
  BROWSER_TRACES=false
RUN ./node_modules/.bin/playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system browser \
  && useradd --system --gid browser --create-home browser \
  && chown -R browser:browser /app /home/browser
# No package manager is used at runtime; omit its unused vendored dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node
USER browser
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
