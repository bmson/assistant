import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPostgresDocumentProcessorRepository, type Db, type TaskRow } from '@assistant/db';
import {
  type DocumentExtractionMetadata,
  type DocumentProcessorRepository,
  documentExtractionMetadata,
  type TaskRepository,
} from '@assistant/persistence';
import { hashCallbackToken } from '../browse.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import type { CodeJobOutcome } from './jobs.js';

/**
 * The document-processor worker (Phase 14) — a third credential-free Cloud Run
 * Job. Heavy formats (office documents, images, scanned PDFs) are parked by
 * document ingest with `extractor='pending_processor'`; the agent container
 * never loads their parsers. This module launches the out-of-process worker,
 * which reads the bytes from the Workspace, extracts plain text (OCR / office
 * parsing), uploads the text to the Workspace, and calls back over a single
 * HTTP request authenticated by a one-shot token.
 *
 * Unlike the code/browser jobs — launched from a tool with a task `pendingJob`
 * slot — document processing is a background pipeline with no model loop. The
 * one-shot token therefore lives on the `documents` row itself, so the worker
 * needs no task context and the callback re-enters the existing
 * `documents.extract` chunk+embed pipeline (see runDocumentExtraction) rather
 * than embedding inside the HTTP handler. The worker stays DB-free and
 * key-free: it only ever handles bytes in and text out.
 */

const PROCESS_BATCH = 5; // documents launched per sweep tick
const STALE_MS = 15 * 60 * 1000; // relaunch a run that never called back
// A worker that repeatedly dies without calling back (OOM on a crafted
// archive, an OCR hang) must not relaunch forever: each launch bills job
// runtime. Three attempts covers transient infrastructure failures.
const PROCESSOR_MAX_ATTEMPTS = 3;
const CALLBACK_GRACE_SECONDS = 600; // Cloud Run task-timeout ceiling for the worker

/** Deterministic Workspace path for a document's extracted text. The callback
 *  derives this itself — it never trusts a path the worker reports. */
export function extractedTextPath(documentId: string): string {
  return `documents/${documentId}/extracted.txt`;
}

// ── Launcher (mirrors the code job's Local/CloudRun pair) ─────────────────────

/** How the worker finds Workspace storage. Credential-free: GCS rides the
 *  runtime service account (prod) or the local filesystem (dev). */
export interface DocumentJobStorage {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface DocumentJobLaunchInput {
  documentId: string;
  source: { workspacePath: string; mime: string; title: string; extractor: string };
  /** Where the worker uploads the extracted text (relative to the Workspace prefix). */
  outputPath: string;
  callbackUrl: string;
  callbackToken: string;
}

export interface DocumentProcessorLauncher {
  launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }>;
}

/** The Cloud Run `:run` POST may have reached Google even though its response
 *  did not reach us; relaunching could start a second run, so the sweep keeps
 *  its already-staged token instead of relaunching. */
export class AmbiguousDocumentJobLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousDocumentJobLaunchError';
  }
}

export function isAmbiguousDocumentJobLaunchError(
  error: unknown,
): error is AmbiguousDocumentJobLaunchError {
  return error instanceof AmbiguousDocumentJobLaunchError;
}

/** Dev: run the worker as a detached child process against the local workspace. */
export class LocalDocumentProcessLauncher implements DocumentProcessorLauncher {
  constructor(private opts: { repoRoot: string; workspaceRoot: string }) {}

  async launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = {
      ...input,
      storage: { driver: 'local', root: this.opts.workspaceRoot } satisfies DocumentJobStorage,
    };
    const inherited = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'PNPM_HOME', 'COREPACK_HOME']
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const child = spawn('pnpm', ['--filter', '@assistant/document-processor', 'start'], {
      cwd: this.opts.repoRoot,
      env: {
        ...inherited,
        NODE_ENV: 'production',
        DOCUMENT_JOB_INPUT: JSON.stringify(jobInput),
      },
      stdio: 'ignore',
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { executionName: `local-pid-${child.pid}` };
  }
}

/** Prod: execute the Cloud Run Job with per-run env overrides (metadata-server auth, no SDK). */
export class CloudRunDocumentJobLauncher implements DocumentProcessorLauncher {
  constructor(
    private opts: {
      project: string;
      location: string;
      jobName: string;
      storage: DocumentJobStorage;
    },
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async launch(input: DocumentJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = { ...input, storage: this.opts.storage };
    const url = `https://run.googleapis.com/v2/projects/${this.opts.project}/locations/${this.opts.location}/jobs/${this.opts.jobName}:run`;
    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              { env: [{ name: 'DOCUMENT_JOB_INPUT', value: JSON.stringify(jobInput) }] },
            ],
            timeout: `${CALLBACK_GRACE_SECONDS}s`,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AmbiguousDocumentJobLaunchError(
        `cloud run document job launch response was not received: ${String(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => 'response body unavailable');
      if (res.status >= 500 || res.status === 408) {
        throw new AmbiguousDocumentJobLaunchError(
          `cloud run document job launch outcome is unknown: ${res.status} ${detail}`,
        );
      }
      throw new Error(`cloud run document job launch failed: ${res.status} ${detail}`);
    }
    let op: { metadata?: { name?: string } };
    try {
      op = (await res.json()) as { metadata?: { name?: string } };
    } catch (error) {
      throw new AmbiguousDocumentJobLaunchError(
        'cloud run accepted the document job launch but returned an unreadable operation response',
        { cause: error },
      );
    }
    return { executionName: op.metadata?.name };
  }
}

// ── Sweep code job: launch the worker for pending documents ───────────────────

export interface DocumentProcessorConfig {
  launcher: DocumentProcessorLauncher;
  /** POST target for the worker's one-shot-token result callback. */
  callbackUrl: string;
}

export interface DocumentProcessDeps {
  db: Db;
  /** The portable processor lifecycle; without it the job reads and writes PostgreSQL. */
  processorStore?: DocumentProcessorRepository;
  documentProcessor?: DocumentProcessorConfig;
  now?: () => Date;
  heartbeat?: () => Promise<void>;
}

/**
 * Code job `documents.process`. With a `documentId` payload it targets one
 * freshly-ingested document; without one it sweeps every heavy-format document
 * whose processor run is missing or stale (the retry backstop). Each launch is
 * an atomic claim: the token hash + start time are written only if the row is
 * still unclaimed/stale, so two overlapping sweeps never double-launch.
 *
 * A no-op — returning "not configured" — when no processor launcher is wired.
 * That is how the feature stays inert in production until the Cloud Run Job is
 * deployed and `PROCESSOR_DRIVER=cloudrun` is set: parked documents simply wait.
 */
export async function runDocumentProcessing(
  deps: DocumentProcessDeps,
  task: TaskRow,
): Promise<CodeJobOutcome> {
  const processor = deps.documentProcessor;
  if (!processor) {
    return {
      done: true,
      summary: 'document processor not configured — pending documents left as-is',
    };
  }
  const now = deps.now?.() ?? new Date();
  const store = deps.processorStore ?? createPostgresDocumentProcessorRepository(deps.db);
  const payload = (task.trigger as { payload?: { documentId?: unknown } } | null)?.payload;
  const documentId = typeof payload?.documentId === 'string' ? payload.documentId : null;

  return withSpan('documents.process', { documentId: documentId ?? 'sweep' }, async () => {
    await deps.heartbeat?.();
    const staleBefore = new Date(now.getTime() - STALE_MS);

    // Retire documents that have burned through their launch budget before
    // selecting fresh work, so an exhausted row can never be claimed again.
    await store.retireExhausted(PROCESSOR_MAX_ATTEMPTS, now, staleBefore);
    const rows = await store.claimable({
      ...(documentId ? { documentId } : {}),
      staleBefore,
      limit: documentId ? 1 : PROCESS_BATCH,
    });

    let launched = 0;
    let skipped = 0;
    for (const row of rows) {
      await deps.heartbeat?.();
      const callbackToken = randomBytes(24).toString('hex');
      // Atomic claim: only take the row if it is still unclaimed/stale.
      if (
        !(await store.claim(row.id, {
          tokenHash: hashCallbackToken(callbackToken),
          now,
          staleBefore,
          maxAttempts: PROCESSOR_MAX_ATTEMPTS,
        }))
      ) {
        skipped++;
        continue;
      }

      try {
        const { executionName } = await processor.launcher.launch({
          documentId: row.id,
          source: {
            workspacePath: row.workspacePath,
            mime: row.mime,
            title: row.title,
            extractor: row.extractor,
          },
          outputPath: extractedTextPath(row.id),
          callbackUrl: processor.callbackUrl,
          callbackToken,
        });
        void executionName;
        launched++;
      } catch (error) {
        if (isAmbiguousDocumentJobLaunchError(error)) {
          // The run may have started; keep the claim and wait for its callback
          // or the staleness relaunch. Never issue a second launch now.
          launched++;
          continue;
        }
        // A definite launch failure: release the claim so the next sweep retries.
        await store.release(row.id, now, hashCallbackToken(callbackToken));
        console.error(`document processor launch failed for ${row.id}`, error);
      }
    }

    return {
      done: true,
      summary: `document processor: ${launched} launched${skipped ? `, ${skipped} already in flight` : ''}`,
    };
  });
}

// ── One-shot callback ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DocumentProcessorResult {
  ok: boolean;
  /** 'text' on success, or 'unsupported' when the worker could not parse the format. */
  kind?: string;
  chars?: number;
  structure?: unknown;
  error?: string;
}

export type DocumentProcessorCallbackOutcome =
  | { ok: true; documentId: string; enqueued: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410 | 503; error: string; cleanupPath?: string };

/**
 * The worker's one-shot callback. Verify the launch token against the document
 * row's checkpoint, then either hand the extracted text to the chunk+embed
 * pipeline (success) or mark the document unsupported/failed. The token is
 * cleared here, so a replayed callback is rejected. Mirrors the code job's
 * recordCodeJobResult, but keyed on the document rather than a task pendingJob.
 */
export async function recordDocumentProcessorResult(
  store: Db | { processor: DocumentProcessorRepository; tasks: TaskRepository },
  input: { documentId: string; token: string; result: DocumentProcessorResult },
): Promise<DocumentProcessorCallbackOutcome> {
  if (!input.documentId || !input.token) return { ok: false, status: 400, error: 'bad request' };
  if (!UUID_RE.test(input.documentId)) return { ok: false, status: 400, error: 'bad request' };
  const portable = 'processor' in store ? store : null;
  const processor = portable?.processor ?? createPostgresDocumentProcessorRepository(store as Db);

  const given = hashCallbackToken(input.token);
  const unsupported = input.result.kind === 'unsupported';
  let extractionMetadata: DocumentExtractionMetadata | null;
  try {
    extractionMetadata = input.result.ok ? documentExtractionMetadata(input.result) : null;
  } catch {
    return { ok: false, status: 400, error: 'invalid extraction coverage' };
  }
  const recorded = await processor.recordResult({
    documentId: input.documentId,
    tokenHash: given,
    resultDigest: createHash('sha256')
      .update(
        JSON.stringify({
          ok: input.result.ok,
          kind: input.result.kind ?? null,
          chars: input.result.chars ?? null,
          error: input.result.error ?? null,
          extractionMetadata,
        }),
      )
      .digest('hex'),
    tokenMatches: (stored) => tokensMatch(stored, given),
    ok: input.result.ok,
    unsupported,
    error: input.result.error ?? (unsupported ? 'format not supported' : 'processing failed'),
    // The path is derived here — a worker-reported path is never trusted.
    processedTextPath: extractedTextPath(input.documentId),
    extractionMetadata,
    now: new Date(),
  });
  if (!recorded.ok) return recorded;

  // The durable extraction task (and Firestore wake intent) already committed
  // with callback consumption. Notification is only an acceleration; the due
  // task backstop repairs a crash here without reprocessing source bytes.
  if (recorded.wake && !recorded.replayed) {
    try {
      getQueueNotifier().notify(recorded.wake.id, recorded.wake.queueGeneration);
    } catch (error) {
      console.error('document extraction wake deferred to backstop', error);
    }
  }
  return { ok: true, documentId: recorded.documentId, enqueued: recorded.extract };
}
