# The Workspace document-processor job (Cloud Run Job, Phase 14). Credential-free:
# no DB URL, no API keys — only the per-run DOCUMENT_JOB_INPUT env. Reads a
# document's bytes from the Workspace, extracts plain text (office parsing plus
# OCR for images and scanned PDFs), writes the text back, and calls home.

# Resolve workspace tooling in a build-only stage and deploy the worker with
# production dependencies only; the root TypeScript/esbuild development tools
# are excluded from the final image.
FROM node:22-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/document-processor ./workers/document-processor
RUN pnpm install --frozen-lockfile --filter @assistant/document-processor... \
  && pnpm --filter @assistant/document-processor deploy --prod --legacy /runtime

FROM node:22-slim
WORKDIR /app
# tesseract (OCR) + poppler (pdftoppm rasterizes scanned PDFs page-by-page).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /runtime ./
RUN groupadd --system docproc && useradd --system --gid docproc --create-home docproc \
  && chown -R docproc:docproc /app /home/docproc
ENV NODE_ENV=production
# No package manager is used at runtime; omit its unused vendored dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node
USER docproc
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
