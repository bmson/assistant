/**
 * Opt-in, task-specific browser qualification for the four existing BASIC5 saves.
 * EXECUTION HOLD: do not run through `pnpm test`. Ordinary Vitest discovery skips
 * this case. A future run requires a reviewed owned-target supervisor because
 * the existing wrapper cleans unconditionally and has no cumulative deadline.
 * The explicit test opt-in also requires a clean, exact-source-pinned standalone
 * artifact and synthetic seed identity.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, mkdtemp, opendir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from '@assistant/db';
import type {
  Request as BrowserRequest,
  Response as BrowserResponse,
  Locator,
  Page,
} from 'playwright';
import { expect, it } from 'vitest';
import {
  assertBasic5AnonymousPageResponse,
  assertBasic5ReceiptSequence,
  BASIC5_AUTH_COOKIE_NAME,
  BASIC5_BROWSER_DYNAMIC_REQUEST_LIMIT,
  BASIC5_BROWSER_STATIC_ASSET_REQUEST_LIMIT,
  BASIC5_BROWSER_TOTAL_REQUEST_LIMIT,
  BASIC5_EMBEDDING_DIMENSIONS,
  BASIC5_FIXTURE_CONNECTION_ID,
  BASIC5_FIXTURE_MODEL_ID,
  BASIC5_READINESS_ATTEMPT_LIMIT,
  type Basic5ObservedPost,
  basic5BrowserLaunchOptions,
  basic5EmbeddingResponse,
  basic5IsolatedWebEnvironment,
  boundedBasic5ObservedCount,
  classifyBasic5RequestFailure,
  createBasic5AuthCookie,
  createBasic5BrowserRequestBudget,
  nextBasic5ReadinessAttempt,
} from './basic5-browser-acceptance-support.js';
import {
  type Basic5ReplyObservation,
  type Basic5SaveObservationDiagnostic,
  decodeBasic5ObservedReply,
  observeBasic5Save,
} from './basic5-browser-save-observation.js';
import {
  assertBasic5CiProcessRegistryComplete,
  BASIC5_CI_CHROME_EXECUTABLE,
  type Basic5CiProcessRegistry,
  createBasic5CiProcessRegistry,
  readBasic5LinuxProcessIdentity,
  readBasic5LinuxProcessSnapshot,
  selectBasic5CiBrowserProcess,
} from './basic5-ci-process-proof.js';
import {
  type Basic5CiFixtureCheckpoint,
  type Basic5FixtureCounters,
  type Basic5SaveTransport,
  classifyBasic5AnonymousLocation,
} from './basic5-ci-vitest-diagnostics.js';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from './test-target.js';

const enabled = process.env.ASSISTANT_RUN_BASIC5_BROWSER_ACCEPTANCE === '1';
const ciAcceptanceEnabled = process.env.ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE === '1';
const ciRegistryPath = process.env.ASSISTANT_BASIC5_CI_REGISTRY_FILE;
const targetDatabaseUrl = process.env.DATABASE_URL;
const allocatedToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (ciAcceptanceEnabled && process.env.CI !== 'true')
  throw new Error('BASIC5 CI acceptance opt-in is valid only in CI.');
if (ciAcceptanceEnabled && !enabled)
  throw new Error('The BASIC5 CI controller must pass the inner browser acceptance opt-in.');
if (enabled && process.env.CI === 'true' && !ciAcceptanceEnabled)
  throw new Error('CI BASIC5 browser acceptance requires the separate reviewed CI opt-in.');
if (enabled && process.env.CI === 'true' && !ciRegistryPath)
  throw new Error('CI BASIC5 browser acceptance requires the private process registry path.');
if (enabled && process.env.CI === 'true' && process.platform !== 'linux')
  throw new Error('CI BASIC5 process registration is supported only on Linux.');
if (enabled && (!targetDatabaseUrl || !allocatedToken))
  throw new Error('A reviewed supervisor and its fresh allocated target URL/token are required');

const wait = (milliseconds: number) => delay(milliseconds);
const OWNER_NOTE_V1 = 'Alex Rivera is a synthetic fixture contact for a saved note correction.';
const OWNER_NOTE_V2 = 'Alex Rivera is the same synthetic contact after a reviewed note correction.';
const SYNTHETIC_OWNER_EMAIL = 'basic5-owner@example.test';
const SYNTHETIC_OWNER_NAME = 'BASIC5 Synthetic Owner';
const CHILD_STOP_TIMEOUT_MS = 8_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const WEB_READY_TIMEOUT_MS = 90_000;
const WEB_READY_INTERVAL_MS = 200;
const EMBEDDING_REQUEST_LIMIT = 3;
const EMBEDDING_BODY_BYTE_LIMIT = 64 * 1024;
const EVIDENCE_PREFIX = 'BASIC5_ACCEPTANCE_EVIDENCE ';
const CHECKPOINT_PREFIX = 'BASIC5_ACCEPTANCE_CHECKPOINT ';
const ACCEPTANCE_PAGE = '/people';
const OWNER_EDITOR_PATHS = new Set([
  '/api/people/editor',
  '/api/profile/knowledge/family',
  '/api/profile/knowledge/memory',
]);

type Receipt = {
  authority: string;
  command: string;
  operationId: string;
  requestHash: string;
  statusVersion: number;
  outcome: string;
  ids?: Record<string, string>;
};

const CHECKPOINT_STAGES = [
  'fixture_setup_started',
  'fixture_prepared',
  'web_ready',
  'browser_launch_started',
  'browser_launched',
  'anonymous_probe_complete',
  'auth_cookie_installed',
  'authenticated_navigation_complete',
  'identity_apply_complete',
  'identity_durable_readback_complete',
  'identity_fresh_page_readback_complete',
  'family_add_apply_complete',
  'family_add_durable_readback_complete',
  'family_add_fresh_page_readback_complete',
  'family_correction_apply_complete',
  'family_correction_durable_readback_complete',
  'family_correction_fresh_page_readback_complete',
  'note_correction_apply_complete',
  'note_correction_durable_readback_complete',
  'note_correction_fresh_page_readback_complete',
  'case_complete',
] as const;

type Basic5CheckpointStage = (typeof CHECKPOINT_STAGES)[number];

function withCheckpointOnFailure<T>(emit: () => void, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    emit();
    throw error;
  }
}

async function withCheckpointOnFailureAsync<T>(
  emit: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    emit();
    throw error;
  }
}

function waitForListening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Local fixture server failed'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  let timeout: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  const bounded = new Promise<void>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Local fixture server did not close in 2 seconds.')),
      2_000,
    );
  });
  return Promise.race([closed, bounded]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await waitForListening(server);
  await closeServer(server);
  return port;
}

function startOwnedProcess(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { child: ChildProcess } {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return { child };
}

function ownedProcessGroupExists(child: ChildProcess): boolean {
  if (process.platform === 'win32' || !child.pid) return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

async function waitForOwnedProcessExit(
  processInfo: ReturnType<typeof startOwnedProcess>,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (
      (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) &&
      !ownedProcessGroupExists(processInfo.child)
    )
      return true;
    await wait(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return (
    (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) &&
    !ownedProcessGroupExists(processInfo.child)
  );
}

async function stopOwnedProcess(processInfo: ReturnType<typeof startOwnedProcess>): Promise<void> {
  const { child } = processInfo;
  const deadline = Date.now() + CHILD_STOP_TIMEOUT_MS;
  try {
    if (ownedProcessGroupExists(child)) {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const termDeadline = Math.min(deadline, Date.now() + Math.floor(CHILD_STOP_TIMEOUT_MS / 2));
  const stopped = await waitForOwnedProcessExit(processInfo, termDeadline);
  if (!stopped) {
    try {
      if (ownedProcessGroupExists(child)) {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (!(await waitForOwnedProcessExit(processInfo, deadline)))
      throw new Error('Owned standalone web process group did not exit before database cleanup.');
  }
}

async function waitForWeb(
  url: string,
  child: ChildProcess,
  recordAttempt: (attempt: number) => void,
): Promise<void> {
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Prebuilt standalone web process exited before readiness.');
    attempts = nextBasic5ReadinessAttempt(attempts);
    recordAttempt(attempts);
    try {
      const timeout = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // The owned process is still starting; this loop is bounded.
    }
    await wait(Math.min(WEB_READY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `Prebuilt standalone web process did not become ready within ${WEB_READY_TIMEOUT_MS}ms.`,
  );
}

async function verifyStandaloneArtifact(
  repoRoot: string,
): Promise<{ entry: string; cwd: string; staticAssetPaths: ReadonlySet<string> }> {
  const expectedSource = process.env.ASSISTANT_BASIC5_STANDALONE_SOURCE_SHA;
  const expectedBuildId = process.env.ASSISTANT_BASIC5_STANDALONE_BUILD_ID;
  const expectedServerHash = process.env.ASSISTANT_BASIC5_STANDALONE_SERVER_SHA256;
  if (process.platform === 'win32')
    throw new Error('Acceptance requires process-group cleanup verification on a POSIX host.');
  if (
    !expectedSource ||
    !/^[a-f0-9]{40,64}$/.test(expectedSource) ||
    !expectedBuildId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(expectedBuildId) ||
    !expectedServerHash ||
    !/^[a-f0-9]{64}$/.test(expectedServerHash)
  )
    throw new Error('Pinned standalone artifact metadata is required for acceptance.');
  const sourceHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const trackedChanges = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim();
  if (sourceHead !== expectedSource || trackedChanges)
    throw new Error('Standalone source pin does not match a clean acceptance checkout.');
  const cwd = path.join(repoRoot, 'apps/web/.next/standalone/apps/web');
  const entry = path.join(cwd, 'server.js');
  const buildIdPath = path.join(cwd, '.next/BUILD_ID');
  for (const directory of [repoRoot, path.join(repoRoot, 'apps/web'), cwd]) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      let exists = false;
      try {
        await access(path.join(directory, name));
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Could not verify absence of dotenv files for acceptance.');
      }
      if (exists)
        throw new Error('Dotenv files must be absent for the isolated acceptance process.');
    }
  }
  const [serverBytes, buildId] = await Promise.all([
    readFile(entry),
    readFile(buildIdPath, 'utf8'),
    access(path.join(cwd, '.next/static')),
    access(path.join(cwd, 'public')),
  ]);
  if (buildId.trim() !== expectedBuildId)
    throw new Error('Standalone build ID does not match the approved artifact pin.');
  if (createHash('sha256').update(serverBytes).digest('hex') !== expectedServerHash)
    throw new Error('Standalone server hash does not match the approved artifact pin.');
  // This locally observed path set classifies synthetic HTTP budget only; it
  // is not an independent comparison against the preflight static digest.
  const staticRoot = path.join(cwd, '.next/static');
  const staticInfo = await lstat(staticRoot);
  const staticReal = await realpath(staticRoot);
  const serverReal = await realpath(cwd);
  if (
    !staticInfo.isDirectory() ||
    staticInfo.isSymbolicLink() ||
    !staticReal.startsWith(`${serverReal}${path.sep}`)
  )
    throw new Error('Static asset root must be a confined regular directory.');
  const staticAssetPaths = new Set<string>();
  let staticEntries = 0;
  const inventoryStaticPaths = async (directory: string, segments: string[]): Promise<void> => {
    for await (const item of await opendir(directory)) {
      staticEntries += 1;
      const parts = [...segments, item.name];
      if (
        staticEntries > 50_000 ||
        Buffer.byteLength(parts.join('/')) > 4096 ||
        parts.some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.includes('\\') ||
            [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
        )
      )
        throw new Error('Static asset inventory exceeded its safe path bounds.');
      if (item.isDirectory()) await inventoryStaticPaths(path.join(directory, item.name), parts);
      else if (item.isFile())
        staticAssetPaths.add(`/_next/static/${parts.map(encodeURIComponent).join('/')}`);
      else throw new Error('Static asset inventory must not contain symlinks or special files.');
    }
  };
  await inventoryStaticPaths(staticRoot, []);
  if (staticAssetPaths.size === 0) throw new Error('Static asset inventory must not be empty.');
  return { entry, cwd, staticAssetPaths };
}

async function saveWithReceipt(
  page: Page,
  operation: Basic5SaveObservationDiagnostic['operation'],
  saveButton: Locator,
  observation: {
    activateRequestObserver: (notify: (matched: boolean | null) => void) => () => void;
    totalMatchingPostCount: () => number;
    onDiagnostic: (diagnostic: Basic5SaveObservationDiagnostic) => void;
  },
): Promise<{ receipt: Receipt; observed: Basic5ObservedPost; response: BrowserResponse }> {
  const { errors } = await import('playwright');
  let reply: Basic5ReplyObservation | undefined;
  return observeBasic5Save({
    operation,
    page,
    ...observation,
    onDiagnostic: (diagnostic) =>
      observation.onDiagnostic({ ...diagnostic, ...(reply ? { reply } : {}) }),
    click: (timeout) => saveButton.click({ timeout }),
    isTimeoutError: (error) => error instanceof errors.TimeoutError,
    matchResponse: (response) => {
      try {
        return (
          response.request().method() === 'POST' &&
          OWNER_EDITOR_PATHS.has(new URL(response.url()).pathname)
        );
      } catch {
        return false;
      }
    },
    status: (response) => response.status(),
    readUi: () =>
      page.evaluate(
        (label) => {
          // Read only fixed-label presence and native validity: no values, IDs, HTML,
          // storage, validation events, focus, submit or recovery actions.
          const unknown = {
            nativeValid: null,
            invalidControlPresent: null,
            alertPresent: null,
            saveEnabled: null,
          };
          const buttons = document.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
          if (buttons.length > 16) return unknown;
          const visible = Array.from(buttons).filter(
            (button) => button.getClientRects().length > 0 && button.textContent?.trim() === label,
          );
          if (visible.length !== 1) return unknown;
          const button = visible[0];
          const form = button?.form;
          return {
            nativeValid: form ? form.matches(':valid') : null,
            invalidControlPresent: form
              ? Boolean(form.querySelector('[aria-invalid="true"]'))
              : null,
            alertPresent: form ? Boolean(form.querySelector('[role="alert"]')) : null,
            saveEnabled: button ? !button.matches(':disabled') : null,
          };
        },
        operation === 'correct_owner_family_relationship' || operation === 'correct_owner_memory'
          ? 'Save correction'
          : 'Save',
      ),
    parse: async (response) => {
      if (!response.ok()) throw new Error(`Owner-editor save returned HTTP ${response.status()}`);
      const [{ decodeOwnerEditorReply }, { ownerEditorRequestHash }, { parseOwnerEditorRequest }] =
        await Promise.all([
          import('../apps/web/lib/owner-editor-client.js'),
          import('../packages/application/src/owner-editor-hash.js'),
          import('../packages/application/src/owner-editor-wire.js'),
        ]);
      const body = response.request().postDataJSON() as Record<string, unknown>;
      const path = new URL(response.url()).pathname;
      const parsed = parseOwnerEditorRequest(
        body,
        path as
          | '/api/people/editor'
          | '/api/profile/knowledge/family'
          | '/api/profile/knowledge/memory',
      );
      if (!parsed.ok || parsed.request.intent !== 'apply' || parsed.request.command !== operation)
        throw new Error('Owner-editor browser request did not match its exact apply contract');
      const decoded = await decodeBasic5ObservedReply<ReturnType<typeof decodeOwnerEditorReply>>({
        response,
        decode: decodeOwnerEditorReply,
        onDiagnostic: (diagnostic) => {
          reply = diagnostic;
        },
      });
      if (!decoded) throw new Error('Owner-editor HTTP reply failed the existing strict decoder');
      if (decoded.authority !== 'operation_receipt' || decoded.outcome !== 'saved')
        throw new Error('Owner-editor request did not return its expected durable saved receipt');
      const receipt: Receipt = {
        authority: decoded.authority,
        command: decoded.command,
        operationId: decoded.operationId,
        requestHash: decoded.requestHash,
        statusVersion: decoded.statusVersion,
        outcome: decoded.outcome,
        ids: decoded.ids as Record<string, string>,
      };
      assert.equal(parsed.request.command, receipt.command);
      assert.equal(parsed.request.operationId, receipt.operationId);
      assert.equal(ownerEditorRequestHash(parsed.request), receipt.requestHash);
      assert.match(receipt.requestHash, /^[a-f0-9]{64}$/);
      assert.equal(receipt.authority, 'operation_receipt');
      assert.equal(receipt.outcome, 'saved');
      return {
        receipt,
        response,
        observed: {
          command: receipt.command,
          operationId: receipt.operationId,
          authority: receipt.authority,
          outcome: receipt.outcome,
        },
      };
    },
  });
}

async function assertStoredReceipt(
  db: Db,
  ownerEditorOperations: typeof import('@assistant/db').ownerEditorOperations,
  eq: typeof import('drizzle-orm').eq,
  receipt: Receipt,
  ownerId: string,
  epoch: string,
) {
  const [row] = await db
    .select()
    .from(ownerEditorOperations)
    .where(eq(ownerEditorOperations.operationId, receipt.operationId))
    .limit(1);
  expect(row).toBeDefined();
  expect(row).toMatchObject({
    ownerId,
    epoch,
    command: receipt.command,
    requestHash: receipt.requestHash,
    status: 'committed',
    statusVersion: receipt.statusVersion,
  });
  expect(row?.result).toMatchObject({
    outcome: 'saved',
    ids: receipt.ids,
  });
}

async function recordFreshPage(page: Page, href: string): Promise<void> {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 15_000 });
}

const browserTest = enabled ? it : it.skip;

browserTest(
  'four BASIC5 saves produce exact receipts and fresh PostgreSQL readbacks through Auth.js',
  async () => {
    let checkpointStage: Basic5CheckpointStage = 'fixture_setup_started';
    let checkpointEmitted = false;
    let checkpointAuthenticatedNavigationCount = 0;
    let checkpointApplyCount = 0;
    let checkpointDurableReadbackCount = 0;
    let checkpointFreshPageReadbackCount = 0;
    let browserHttpRequests = 0;
    let browserDynamicHttpRequests = 0;
    let browserStaticAssetRequests = 0;
    let browserBudgetExceeded = false;
    let embeddingRequests = 0;
    let embeddingResponsesFinished = 0;
    let fixtureCountersAtSave: Basic5FixtureCounters | undefined;
    let saveTransport: Basic5SaveTransport | undefined;
    let stopRequestFailureObservation: (() => void) | undefined;
    const snapshotFixtureCounters = (
      observedAt: Basic5FixtureCounters['observedAt'],
    ): Basic5FixtureCounters => ({
      observedAt,
      browserHttpRequests: boundedBasic5ObservedCount(browserHttpRequests),
      browserBudgetExceeded,
      localEmbeddingReceived: boundedBasic5ObservedCount(embeddingRequests),
      localEmbeddingFinished: boundedBasic5ObservedCount(embeddingResponsesFinished),
    });

    let ownerEditorPostCount = 0;
    let saveObservation: Basic5SaveObservationDiagnostic | undefined;
    let activeSaveRequest: ((matched: boolean | null) => void) | undefined;
    let activeSaveOperation: Basic5SaveObservationDiagnostic['operation'] | undefined;
    let anonymousPageObservation:
      | Pick<Basic5CiFixtureCheckpoint, 'anonymousPageStatus' | 'anonymousLocationClass'>
      | undefined;
    const setCheckpoint = (stage: Basic5CheckpointStage) => {
      checkpointStage = stage;
    };
    const emitCheckpoint = () => {
      if (checkpointEmitted) return;
      checkpointEmitted = true;
      process.stdout.write(
        `${CHECKPOINT_PREFIX}${JSON.stringify({
          schemaVersion: 1,
          stage: checkpointStage,
          authenticatedNavigationCount: checkpointAuthenticatedNavigationCount,
          applyCount: checkpointApplyCount,
          durableReadbackCount: checkpointDurableReadbackCount,
          freshPageReadbackCount: checkpointFreshPageReadbackCount,
          ...anonymousPageObservation,
          fixtureCounters: fixtureCountersAtSave ?? snapshotFixtureCounters('checkpoint'),
          ...(saveTransport ? { saveTransport: { ...saveTransport } } : {}),
          ...(saveObservation
            ? {
                saveObservation: {
                  ...saveObservation,
                  totalMatchingPostCount: ownerEditorPostCount <= 64 ? ownerEditorPostCount : null,
                },
              }
            : {}),
        })}\n`,
      );
    };

    withCheckpointOnFailure(emitCheckpoint, () => assert(targetDatabaseUrl && allocatedToken));
    const [dbSchema, drizzle, playwright, persistence] = await withCheckpointOnFailureAsync(
      emitCheckpoint,
      () =>
        Promise.all([
          import('@assistant/db'),
          import('drizzle-orm'),
          import('playwright'),
          import('@assistant/persistence'),
        ]),
    );
    const {
      agents,
      assertPostgresInstallationOwner,
      contacts,
      createDb,
      knowledgeGraphEntities,
      knowledgeGraphAssertions,
      knowledgeGraphRelations,
      memories,
      maintenanceCursors,
      modelConnections,
      modelRoles,
      models,
      ownerEditorOperations,
    } = dbSchema;
    const { and, eq, or, sql } = drizzle;
    const { chromium } = playwright;
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const standalone = await withCheckpointOnFailureAsync(emitCheckpoint, () =>
      verifyStandaloneArtifact(repoRoot),
    );
    withCheckpointOnFailure(emitCheckpoint, () => {
      if (
        process.env.OWNER_EMAIL !== SYNTHETIC_OWNER_EMAIL ||
        process.env.ASSISTANT_EMAIL !== SYNTHETIC_OWNER_EMAIL ||
        process.env.OWNER_NAME !== SYNTHETIC_OWNER_NAME ||
        process.env.ASSISTANT_NAME !== SYNTHETIC_OWNER_NAME
      )
        throw new Error(
          'Synthetic owner identity must be supplied before allocated-target seeding.',
        );
    });
    const target = withCheckpointOnFailure(emitCheckpoint, () =>
      assertAllocatedTestTargetMarker({
        databaseUrl: targetDatabaseUrl,
        testDatabaseUrl: process.env.TEST_DATABASE_URL,
        token: allocatedToken,
        kind: 'standard',
      }),
    );
    const db = withCheckpointOnFailure(emitCheckpoint, () =>
      createDb(target.databaseUrl, { max: 4 }),
    );
    let processRegistry: Basic5CiProcessRegistry | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let webProcess: ReturnType<typeof startOwnedProcess> | undefined;
    let embeddingServer: Server | undefined;
    let emptyHome: string | undefined;
    let readinessAttempts: number | null = null;
    let anonymousPageProbeRequests = 0;
    let pageApiMutationRequests = 0;
    let authenticatedPageNavigations = 0;
    let ownerEditorGetCount = 0;
    let ownerApplyRequests = 0;
    let recoveryRequests = 0;
    let fixtureModelCallCount = 0;
    let foreignModelCallCount = 0;
    const executionEnvironment = {
      platform: process.platform,
      nodeVersion: process.version,
      browserChannel: process.env.CI === 'true' ? 'chrome' : 'playwright-default',
      browserVersion: null as string | null,
      postgresServerVersionNum: null as number | null,
    };
    let testError: unknown;
    const receipts: Receipt[] = [];
    const durableReadbacks: Record<string, boolean> = {};
    const fixtureManifest: {
      databaseTargetDigest: string;
      ownerId: string;
      epochPrivacyMatchedReady: boolean;
      baseline: {
        contactIds: string[];
        entityIds: string[];
        noteId: string;
        noteHash: string;
      };
      generatedOperationIds: string[];
    } = {
      databaseTargetDigest: createHash('sha256')
        .update(target.databaseName)
        .digest('hex')
        .slice(0, 24),
      ownerId: '',
      epochPrivacyMatchedReady: false,
      baseline: { contactIds: [], entityIds: [], noteId: '', noteHash: '' },
      generatedOperationIds: [],
    };
    try {
      if (process.env.CI === 'true') {
        if (!ciRegistryPath) throw new Error('CI process registry path is missing.');
        processRegistry = await createBasic5CiProcessRegistry(ciRegistryPath);
        await processRegistry.register('fixture-worker', process.pid);
      }
      await assertAllocatedTestDatabaseOwnership(db, target);
      const versionRows = await db.execute<{ server_version_num: string }>(
        sql`SELECT current_setting('server_version_num') AS server_version_num`,
      );
      const postgresServerVersion = versionRows[0]?.server_version_num;
      if (!postgresServerVersion || !/^\d+$/.test(postgresServerVersion))
        throw new Error('PostgreSQL server version metadata is unavailable.');
      const postgresServerVersionNum = Number(postgresServerVersion);
      if (!Number.isSafeInteger(postgresServerVersionNum) || postgresServerVersionNum <= 0)
        throw new Error('PostgreSQL server version number is malformed.');
      executionEnvironment.postgresServerVersionNum = postgresServerVersionNum;
      const [owner] = await db.select().from(agents).limit(2);
      expect(owner).toBeDefined();
      expect(await assertPostgresInstallationOwner(db, owner?.id)).toBe(owner?.id);
      const ownerId = owner?.id;
      const ownerEmail = owner?.email;
      assert(ownerId && ownerEmail);
      expect(ownerEmail).toBe(SYNTHETIC_OWNER_EMAIL);
      expect(owner?.name).toBe(SYNTHETIC_OWNER_NAME);

      const { ownerEditorPrivacyDigest, parseOwnerEditorEpochCursor } = persistence;
      const { postgresPrivacyObservationFence } = await import(
        '../packages/db/src/privacy-erasure-repository.js'
      );
      const privacyGeneration = await postgresPrivacyObservationFence(db, ownerId);
      const epochCursorName = `owner-editor-epoch:${ownerId}`;
      const [currentEpochCursor] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, epochCursorName))
        .limit(1);
      let epoch: string;
      if (currentEpochCursor?.cursor) {
        let cursor: ReturnType<typeof parseOwnerEditorEpochCursor>;
        try {
          cursor = parseOwnerEditorEpochCursor(JSON.parse(currentEpochCursor.cursor));
        } catch {
          throw new Error('Existing isolated-test owner-editor epoch is malformed.');
        }
        if (
          cursor.ownerId !== ownerId ||
          cursor.ready !== true ||
          cursor.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyGeneration)
        )
          throw new Error(
            'Existing isolated-test owner-editor epoch is not ready for this privacy state.',
          );
        epoch = cursor.epoch;
      } else {
        epoch = randomUUID();
        await db.insert(maintenanceCursors).values({
          name: epochCursorName,
          cursor: JSON.stringify({
            ownerId,
            epoch,
            ready: true,
            privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
          }),
        });
      }
      fixtureManifest.ownerId = ownerId;
      fixtureManifest.epochPrivacyMatchedReady = true;

      const personId = randomUUID();
      const relativePersonId = randomUUID();
      const noteId = randomUUID();
      const personEntityId = randomUUID();
      const relativeEntityId = randomUUID();
      const baselineNoteHash = createHash('sha256').update(OWNER_NOTE_V1).digest('hex');
      const formSessionScope = randomUUID().replaceAll('-', '_');
      const authSecret = randomBytes(32).toString('base64url');

      embeddingServer = createServer((request, response) => {
        embeddingRequests += 1;
        response.once('finish', () => {
          embeddingResponsesFinished += 1;
        });
        if (embeddingRequests > EMBEDDING_REQUEST_LIMIT) {
          response.writeHead(429, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"error":"not_found"}');
          return;
        }
        const chunks: Buffer[] = [];
        let requestBytes = 0;
        let tooLarge = false;
        request.on('data', (chunk: Buffer) => {
          if (tooLarge) return;
          requestBytes += chunk.byteLength;
          if (requestBytes > EMBEDDING_BODY_BYTE_LIMIT) {
            tooLarge = true;
            response.writeHead(413);
            response.end();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on('error', () => {});
        request.on('end', () => {
          if (tooLarge) return;
          try {
            const raw = Buffer.concat(chunks, requestBytes).toString('utf8');
            const payload = basic5EmbeddingResponse(JSON.parse(raw) as unknown);
            response.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            });
            response.end(JSON.stringify(payload));
          } catch {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end('{"error":"invalid_fixture_request"}');
          }
        });
      });
      const embeddingPort = await waitForListening(embeddingServer);
      if (processRegistry) await processRegistry.register('embedding', process.pid, embeddingPort);
      const embeddingBaseUrl = `http://127.0.0.1:${embeddingPort}/v1`;
      const webPort = await unusedLoopbackPort();
      const baseUrl = `http://127.0.0.1:${webPort}`;

      await db.insert(contacts).values([
        {
          id: personId,
          name: 'Alex Rivera',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'synthetic acceptance fixture',
          trust: 'known',
          notes: 'basic5-acceptance:person',
        },
        {
          id: relativePersonId,
          name: 'Robin Rivera',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'synthetic acceptance fixture',
          trust: 'known',
          notes: 'basic5-acceptance:relative',
        },
      ]);
      await db.insert(knowledgeGraphEntities).values([
        {
          id: personEntityId,
          agentId: ownerId,
          canonicalKey: `contact:${personId}`,
          label: 'Alex Rivera',
          kind: 'person',
          contactId: personId,
        },
        {
          id: relativeEntityId,
          agentId: ownerId,
          canonicalKey: `contact:${relativePersonId}`,
          label: 'Robin Rivera',
          kind: 'person',
          contactId: relativePersonId,
        },
      ]);
      await db.insert(memories).values({
        id: noteId,
        agentId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: OWNER_NOTE_V1,
        contentHash: baselineNoteHash,
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: true,
        subjectContactId: personId,
        domain: 'relationships',
        source: 'manual',
        importance: 3,
        confidence: '1.00',
        embedding: Array.from({ length: BASIC5_EMBEDDING_DIMENSIONS }, (_, index) =>
          index === 0 ? 1 : 0,
        ),
      });
      await db.insert(modelConnections).values({
        id: BASIC5_FIXTURE_CONNECTION_ID,
        kind: 'openai_compatible',
        label: 'Local BASIC5 acceptance embedding fixture',
        baseUrl: embeddingBaseUrl,
        apiKeyEncrypted: null,
        vertexProject: null,
        vertexLocation: null,
        enabled: true,
      });
      await db
        .insert(models)
        .values({
          id: BASIC5_FIXTURE_MODEL_ID,
          label: 'Local BASIC5 acceptance embedding fixture',
          capabilities: { embedding: true },
          promptCostPerMTok: '0.0100',
          completionCostPerMTok: '0.0000',
          latencyClass: 'fast',
          enabled: true,
        })
        .onConflictDoUpdate({
          target: models.id,
          set: {
            capabilities: { embedding: true },
            promptCostPerMTok: '0.0100',
            completionCostPerMTok: '0.0000',
            enabled: true,
          },
        });
      await db
        .insert(modelRoles)
        .values({
          role: 'embed',
          primaryModel: BASIC5_FIXTURE_MODEL_ID,
          fallbackModel: BASIC5_FIXTURE_MODEL_ID,
        })
        .onConflictDoUpdate({
          target: modelRoles.role,
          set: { primaryModel: BASIC5_FIXTURE_MODEL_ID, fallbackModel: BASIC5_FIXTURE_MODEL_ID },
        });
      fixtureManifest.baseline = {
        contactIds: [personId, relativePersonId],
        entityIds: [personEntityId, relativeEntityId],
        noteId,
        noteHash: baselineNoteHash,
      };
      setCheckpoint('fixture_prepared');

      const egressPreloader = fileURLToPath(new URL('./deny-test-egress.mjs', import.meta.url));
      emptyHome = await mkdtemp(path.join(tmpdir(), 'basic5-empty-home-'));
      const childEnv = basic5IsolatedWebEnvironment({
        source: process.env,
        databaseUrl: target.databaseUrl,
        targetToken: target.token,
        ownerEmail,
        ownerName: SYNTHETIC_OWNER_NAME,
        authSecret,
        emptyHome,
        authUrl: baseUrl,
        embeddingBaseUrl,
        denyEgressPreloader: egressPreloader,
      });
      webProcess = startOwnedProcess(
        standalone.entry,
        [],
        { ...childEnv, PORT: String(webPort), HOSTNAME: '127.0.0.1' },
        standalone.cwd,
      );
      if (processRegistry) {
        if (!webProcess.child.pid) throw new Error('Standalone web process has no PID.');
        await processRegistry.register('web', webProcess.child.pid, webPort);
      }
      await waitForWeb(`${baseUrl}/profile`, webProcess.child, (attempt) => {
        readinessAttempts = attempt;
      });
      setCheckpoint('web_ready');

      const browserProcessesBefore = processRegistry
        ? await readBasic5LinuxProcessSnapshot()
        : undefined;
      setCheckpoint('browser_launch_started');
      browser = await chromium.launch(basic5BrowserLaunchOptions(process.env.CI === 'true'));
      setCheckpoint('browser_launched');
      executionEnvironment.browserVersion = browser.version();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(executionEnvironment.browserVersion))
        throw new Error('Browser version metadata is malformed.');
      if (processRegistry && browserProcessesBefore) {
        const after = await readBasic5LinuxProcessSnapshot();
        const newDirectChildren = [...after.values()].filter((identity) => {
          const previous = browserProcessesBefore.get(identity.pid);
          return (
            identity.ppid === process.pid &&
            (!previous || previous.startTimeTicks !== identity.startTimeTicks)
          );
        });
        const fullIdentities = await Promise.all(
          newDirectChildren.map((identity) => readBasic5LinuxProcessIdentity(identity.pid)),
        );
        if (fullIdentities.some((identity) => identity === undefined))
          throw new Error('A new browser-launch child disappeared during identity capture.');
        const identities = fullIdentities.filter(
          (identity): identity is NonNullable<typeof identity> => identity !== undefined,
        );
        const afterWithExecutables = new Map(
          identities.map((identity) => [identity.pid, identity]),
        );
        const browserIdentity = selectBasic5CiBrowserProcess(
          browserProcessesBefore,
          afterWithExecutables,
          process.pid,
        );
        if (browserIdentity.exe !== BASIC5_CI_CHROME_EXECUTABLE)
          throw new Error('Launched browser did not use the allowlisted CI Chrome executable.');
        await processRegistry.register('browser', browserIdentity.pid);
      }
      executionEnvironment.browserVersion = browser.version();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(executionEnvironment.browserVersion))
        throw new Error('Browser version metadata is malformed.');
      const context = await browser.newContext();
      const browserRequestBudget = createBasic5BrowserRequestBudget(
        baseUrl,
        standalone.staticAssetPaths,
      );
      const observeBrowserRequest = (url: string, method: string): boolean => {
        const allowed = browserRequestBudget.observe(url, method);
        ({
          browserHttpRequests,
          browserDynamicHttpRequests,
          browserStaticAssetRequests,
          browserBudgetExceeded,
        } = browserRequestBudget.snapshot());
        return allowed;
      };
      const isIntendedPost = (request: BrowserRequest): boolean => {
        if (!activeSaveOperation || !activeSaveRequest || request.method() !== 'POST') return false;
        try {
          if (!OWNER_EDITOR_PATHS.has(new URL(request.url()).pathname)) return false;
          const body = request.postDataJSON();
          return body?.intent === 'apply' && body?.command === activeSaveOperation;
        } catch {
          return false;
        }
      };
      await context.route('**/*', (route) => {
        const intended = isIntendedPost(route.request());
        const allowed = observeBrowserRequest(route.request().url(), route.request().method());
        if (intended && saveTransport)
          saveTransport.routeBlocked = saveTransport.routeBlocked === true || !allowed;
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });
      // The one anonymous probe consumes the same dynamic and total allowance.
      if (!observeBrowserRequest(`${baseUrl}${ACCEPTANCE_PAGE}/${personId}`, 'GET'))
        throw new Error('Anonymous probe exceeded the browser request budget.');
      anonymousPageProbeRequests += 1;
      const anonymous = await context.request.get(`${baseUrl}${ACCEPTANCE_PAGE}/${personId}`, {
        maxRedirects: 0,
      });
      // App Router may stream its sign-in redirect after committing an HTML 200.
      // Inspect this same response; never substitute a generic successful status
      // or missing-data check for a positively identified owner-auth redirect.
      const anonymousHeaders = anonymous.headers();
      anonymousPageObservation = {
        anonymousPageStatus: anonymous.status(),
        anonymousLocationClass: classifyBasic5AnonymousLocation(anonymousHeaders.location, baseUrl),
      };
      const declaredBodyBytes = anonymousHeaders['content-length'];
      if (
        declaredBodyBytes &&
        (!/^\d+$/.test(declaredBodyBytes) || Number(declaredBodyBytes) > 64 * 1024)
      )
        throw new Error('Anonymous page response exceeded the bounded inspection contract.');
      await assertBasic5AnonymousPageResponse({
        status: anonymous.status(),
        location: anonymousHeaders.location,
        contentType: anonymousHeaders['content-type'],
        body: await anonymous.body(),
        baseUrl,
        protectedMarkers: [
          // The requested personId itself is public routing input, not a dossier canary.
          'Alex Rivera',
          OWNER_NOTE_V1,
          OWNER_NOTE_V2,
          'Synthetic family statement one.',
          'Synthetic family statement corrected.',
          personEntityId,
          relativeEntityId,
          ownerId,
          noteId,
          'update_person_identity',
          'add_family_relationship',
          'correct_owner_family_relationship',
          'correct_owner_memory',
        ],
      });
      setCheckpoint('anonymous_probe_complete');
      const cookie = await createBasic5AuthCookie({
        email: ownerEmail,
        subject: ownerId,
        formSessionScope,
        secret: authSecret,
      });
      await context.addCookies([
        {
          ...cookie,
          url: baseUrl,
          httpOnly: true,
          sameSite: 'Lax',
          secure: false,
        },
      ]);
      expect(cookie.name).toBe(BASIC5_AUTH_COOKIE_NAME);
      setCheckpoint('auth_cookie_installed');
      const page = await context.newPage();
      const ownerPosts: Basic5ObservedPost[] = [];
      const ownerReads: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (
          pathname.startsWith('/api/') &&
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
        )
          pageApiMutationRequests += 1;
        if (OWNER_EDITOR_PATHS.has(pathname)) {
          ownerReads.push(`${request.method()} ${pathname}`);
          if (request.method() === 'POST') {
            ownerEditorPostCount += 1;
            let intent: unknown;
            let command: unknown;
            try {
              const body = request.postDataJSON();
              intent = body?.intent;
              command = body?.command;
            } catch {
              intent = undefined;
            }
            // Correlate locally; retain only a closed intent and match boolean.
            activeSaveRequest?.(
              typeof command === 'string'
                ? intent === 'apply' && command === activeSaveOperation
                : null,
            );
            if (intent === 'apply') ownerApplyRequests += 1;
            if (intent === 'reconcile') recoveryRequests += 1;
          }
          if (request.method() === 'GET') ownerEditorGetCount += 1;
        }
      });

      const onIntendedRequestFailed = (request: BrowserRequest) => {
        // Ignore browser-close/cleanup failures after the save observer ends.
        if (!isIntendedPost(request) || !saveTransport) return;
        let errorText: unknown;
        try {
          errorText = request.failure()?.errorText;
        } catch {
          errorText = undefined;
        }
        saveTransport.requestFailedClass = classifyBasic5RequestFailure(errorText);
      };
      page.on('requestfailed', onIntendedRequestFailed);
      stopRequestFailureObservation = () => {
        page.off('requestfailed', onIntendedRequestFailed);
      };

      const saveObserved = (
        operation: Basic5SaveObservationDiagnostic['operation'],
        button: Locator,
      ) => {
        saveObservation = undefined;
        fixtureCountersAtSave = undefined;
        saveTransport = { operation, routeBlocked: null, requestFailedClass: null };
        return saveWithReceipt(page, operation, button, {
          activateRequestObserver: (notify) => {
            activeSaveOperation = operation;
            activeSaveRequest = notify;
            return () => {
              if (activeSaveRequest === notify) {
                activeSaveRequest = undefined;
                activeSaveOperation = undefined;
              }
            };
          },
          totalMatchingPostCount: () => ownerEditorPostCount,
          onDiagnostic: (diagnostic) => {
            saveObservation = diagnostic;
            fixtureCountersAtSave = snapshotFixtureCounters('save_settled');
          },
        });
      };

      const personUrl = `${baseUrl}/people/${personId}`;
      const navigate = async (href: string) => {
        await recordFreshPage(page, href);
        authenticatedPageNavigations += 1;
        checkpointAuthenticatedNavigationCount = authenticatedPageNavigations;
        setCheckpoint('authenticated_navigation_complete');
      };
      await navigate(personUrl);
      await page.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit details', exact: true }).click();
      const identityDialog = page.getByRole('dialog');
      await identityDialog
        .getByRole('heading', { name: 'Edit name and aliases', exact: true })
        .waitFor();
      await identityDialog.getByLabel('Name', { exact: true }).fill('Alex Rivera Updated');
      const identity = await saveObserved(
        'update_person_identity',
        identityDialog.getByRole('button', { name: 'Save', exact: true }),
      );
      ownerPosts.push(identity.observed);
      receipts.push(identity.receipt);
      fixtureManifest.generatedOperationIds.push(identity.receipt.operationId);
      checkpointApplyCount = receipts.length;
      setCheckpoint('identity_apply_complete');
      await assertStoredReceipt(db, ownerEditorOperations, eq, identity.receipt, ownerId, epoch);
      const [updatedContact] = await db.select().from(contacts).where(eq(contacts.id, personId));
      const [updatedEntity] = await db
        .select()
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, personEntityId));
      expect(updatedContact).toMatchObject({
        id: personId,
        name: 'Alex Rivera Updated',
        trust: 'known',
      });
      expect(updatedEntity).toMatchObject({
        id: personEntityId,
        agentId: ownerId,
        canonicalKey: `contact:${personId}`,
        contactId: personId,
        label: 'Alex Rivera',
      });
      durableReadbacks.identity = true;
      checkpointDurableReadbackCount = Object.values(durableReadbacks).filter(Boolean).length;
      setCheckpoint('identity_durable_readback_complete');
      await navigate(personUrl);
      await page.getByRole('heading', { name: 'Alex Rivera Updated', exact: true }).waitFor();
      checkpointFreshPageReadbackCount += 1;
      setCheckpoint('identity_fresh_page_readback_complete');

      await page.getByRole('button', { name: 'Add family relationship', exact: true }).click();
      const familyAddDialog = page.getByRole('dialog');
      // The page's person is intentionally the fixed subject, not an editable choice.
      const firstPerson = familyAddDialog.getByLabel('First person', { exact: true });
      const secondPerson = familyAddDialog.getByLabel('Second person', { exact: true });
      expect(await firstPerson.isDisabled()).toBe(true);
      expect(await firstPerson.inputValue()).toBe(personId);
      expect(await secondPerson.isEnabled()).toBe(true);
      await secondPerson.selectOption(relativePersonId);
      expect(await firstPerson.inputValue()).toBe(personId);
      expect(await secondPerson.inputValue()).toBe(relativePersonId);
      await familyAddDialog
        .getByLabel('Relationship of the first person to the second', { exact: true })
        .selectOption('sibling_of');
      await familyAddDialog
        .getByLabel('Note (optional)', { exact: true })
        .fill('Synthetic family statement one.');
      const familyAdd = await saveObserved(
        'add_family_relationship',
        familyAddDialog.getByRole('button', { name: 'Save', exact: true }),
      );
      ownerPosts.push(familyAdd.observed);
      receipts.push(familyAdd.receipt);
      fixtureManifest.generatedOperationIds.push(familyAdd.receipt.operationId);
      checkpointApplyCount = receipts.length;
      setCheckpoint('family_add_apply_complete');
      await assertStoredReceipt(db, ownerEditorOperations, eq, familyAdd.receipt, ownerId, epoch);
      const addedRelationId = familyAdd.receipt.ids?.relationId;
      const addedMemoryId = familyAdd.receipt.ids?.memoryId;
      assert(addedRelationId && addedMemoryId);
      const [addedRelation] = await db
        .select()
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, addedRelationId));
      const [addedMemory] = await db.select().from(memories).where(eq(memories.id, addedMemoryId));
      expect(addedRelation).toMatchObject({
        agentId: ownerId,
        subjectEntityId: personEntityId,
        objectEntityId: relativeEntityId,
        predicate: 'sibling_of',
        assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
        validFrom: null,
        validUntil: null,
        sourceMemoryId: addedMemoryId,
        reviewStatus: 'confirmed',
      });
      expect(addedMemory).toMatchObject({
        agentId: ownerId,
        source: 'knowledge-graph-owner',
        ownerConfirmed: true,
      });
      durableReadbacks.familyAdd = true;
      checkpointDurableReadbackCount = Object.values(durableReadbacks).filter(Boolean).length;
      setCheckpoint('family_add_durable_readback_complete');
      await navigate(personUrl);
      const addedRelationRow = page.locator(`#person-connection-${addedRelationId.toLowerCase()}`);
      await addedRelationRow
        .getByText(
          'Recorded statement: The saved relationship identifies Alex Rivera Updated and Robin Rivera as siblings. Timing recorded: not recorded. Recorded dates: Start and end not recorded.',
          { exact: true },
        )
        .waitFor();
      checkpointFreshPageReadbackCount += 1;
      setCheckpoint('family_add_fresh_page_readback_complete');
      await addedRelationRow
        .getByRole('button', { name: 'Edit relationship', exact: true })
        .click();
      const familyDialog = page.getByRole('dialog');
      await familyDialog
        .getByRole('heading', { name: 'Correct family relationship', exact: true })
        .waitFor();
      await familyDialog
        .getByLabel('Note (optional)', { exact: true })
        .fill('Synthetic family statement corrected.');
      const familyCorrection = await saveObserved(
        'correct_owner_family_relationship',
        familyDialog.getByRole('button', { name: 'Save correction', exact: true }),
      );
      ownerPosts.push(familyCorrection.observed);
      receipts.push(familyCorrection.receipt);
      fixtureManifest.generatedOperationIds.push(familyCorrection.receipt.operationId);
      checkpointApplyCount = receipts.length;
      setCheckpoint('family_correction_apply_complete');
      await assertStoredReceipt(
        db,
        ownerEditorOperations,
        eq,
        familyCorrection.receipt,
        ownerId,
        epoch,
      );
      expect(familyCorrection.receipt.ids?.previousRelationId).toBe(addedRelationId);
      const correctedRelationId = familyCorrection.receipt.ids?.relationId;
      const correctedMemoryId = familyCorrection.receipt.ids?.memoryId;
      assert(correctedRelationId && correctedMemoryId);
      const [correctedRelation] = await db
        .select()
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, correctedRelationId));
      const [supersededMemory] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, addedMemoryId));
      const [originalRelationAfterCorrection] = await db
        .select()
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, addedRelationId));
      const [correctedMemory] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, correctedMemoryId));
      expect(correctedRelation).toMatchObject({
        agentId: ownerId,
        subjectEntityId: personEntityId,
        objectEntityId: relativeEntityId,
        predicate: 'sibling_of',
        assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
        validFrom: null,
        validUntil: null,
        sourceMemoryId: correctedMemoryId,
        reviewStatus: 'confirmed',
      });
      expect(originalRelationAfterCorrection).toMatchObject({
        id: addedRelationId,
        agentId: ownerId,
        subjectEntityId: personEntityId,
        objectEntityId: relativeEntityId,
        predicate: 'sibling_of',
        assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
        validFrom: null,
        validUntil: null,
        sourceMemoryId: addedMemoryId,
        reviewStatus: 'confirmed',
      });
      expect(correctedRelation?.assertionId).toBe(originalRelationAfterCorrection?.assertionId);
      if (!correctedRelation?.assertionId)
        throw new Error('Corrected family relationship has no canonical assertion ID.');
      const matchingCurrentAssertions = await db
        .select()
        .from(knowledgeGraphAssertions)
        .where(
          and(
            eq(knowledgeGraphAssertions.agentId, ownerId),
            eq(knowledgeGraphAssertions.predicate, 'sibling_of'),
            eq(knowledgeGraphAssertions.lifecycle, 'current'),
            or(
              and(
                eq(knowledgeGraphAssertions.subjectEntityId, personEntityId),
                eq(knowledgeGraphAssertions.objectEntityId, relativeEntityId),
              ),
              and(
                eq(knowledgeGraphAssertions.subjectEntityId, relativeEntityId),
                eq(knowledgeGraphAssertions.objectEntityId, personEntityId),
              ),
            ),
          ),
        )
        .limit(2);
      expect(matchingCurrentAssertions).toHaveLength(1);
      const [canonicalAssertion] = matchingCurrentAssertions;
      expect(canonicalAssertion).toMatchObject({
        id: correctedRelation.assertionId,
        agentId: ownerId,
        predicate: 'sibling_of',
        assertion: { tense: 'unspecified', polarity: 'positive', modality: 'asserted' },
        lifecycle: 'current',
        reviewStatus: 'confirmed',
        ownerAuthored: true,
      });
      expect(canonicalAssertion?.reviewedRevision).toBe(canonicalAssertion?.semanticRevision);
      expect(canonicalAssertion?.reviewedPayloadHash).toBe(canonicalAssertion?.semanticKey);
      expect(supersededMemory?.supersededById).toBe(correctedMemoryId);
      expect(correctedMemory?.content).toContain('Synthetic family statement corrected.');
      durableReadbacks.familyCorrection = true;
      checkpointDurableReadbackCount = Object.values(durableReadbacks).filter(Boolean).length;
      setCheckpoint('family_correction_durable_readback_complete');
      await navigate(personUrl);
      const correctedRelationRow = page.locator(
        `#person-connection-${correctedRelationId.toLowerCase()}`,
      );
      await correctedRelationRow
        .getByText(
          'Recorded statement: The saved relationship identifies Alex Rivera Updated and Robin Rivera as siblings. Timing recorded: not recorded. Recorded dates: Start and end not recorded.',
          { exact: true },
        )
        .waitFor();
      await page.getByText('Synthetic family statement corrected.').waitFor();
      checkpointFreshPageReadbackCount += 1;
      setCheckpoint('family_correction_fresh_page_readback_complete');

      const noteUrl = `${baseUrl}/profile/knowledge/notes/${noteId}?returnTo=${encodeURIComponent(`/people/${personId}`)}`;
      await navigate(noteUrl);
      await page.getByText(OWNER_NOTE_V1, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit saved note', exact: true }).click();
      await page.getByLabel('Your corrected note', { exact: true }).fill(OWNER_NOTE_V2);
      const noteCorrection = await saveObserved(
        'correct_owner_memory',
        page.getByRole('button', { name: 'Save correction', exact: true }),
      );
      ownerPosts.push(noteCorrection.observed);
      receipts.push(noteCorrection.receipt);
      fixtureManifest.generatedOperationIds.push(noteCorrection.receipt.operationId);
      checkpointApplyCount = receipts.length;
      setCheckpoint('note_correction_apply_complete');
      await assertStoredReceipt(
        db,
        ownerEditorOperations,
        eq,
        noteCorrection.receipt,
        ownerId,
        epoch,
      );
      expect(noteCorrection.receipt.ids?.memoryId).toBe(noteId);
      const [correctedNote] = await db.select().from(memories).where(eq(memories.id, noteId));
      expect(correctedNote).toMatchObject({
        id: noteId,
        agentId: ownerId,
        content: OWNER_NOTE_V2,
        contentHash: createHash('sha256').update(OWNER_NOTE_V2).digest('hex'),
        source: 'manual',
        ownerConfirmed: true,
        quarantined: false,
        subjectContactId: personId,
      });
      expect(correctedNote?.ownerCorrection).toMatchObject({
        correctedByOwner: true,
        priorContentHash: baselineNoteHash,
        currentContentHash: correctedNote?.contentHash,
      });
      durableReadbacks.noteCorrection = true;
      checkpointDurableReadbackCount = Object.values(durableReadbacks).filter(Boolean).length;
      setCheckpoint('note_correction_durable_readback_complete');
      await navigate(noteUrl);
      await page.getByText(OWNER_NOTE_V2, { exact: true }).waitFor();
      checkpointFreshPageReadbackCount += 1;
      setCheckpoint('note_correction_fresh_page_readback_complete');

      assertBasic5ReceiptSequence(ownerPosts);
      expect(fixtureManifest.generatedOperationIds).toEqual(
        ownerPosts.map((post) => post.operationId),
      );
      expect(ownerReads.filter((entry) => entry.startsWith('POST '))).toHaveLength(4);
      expect(ownerReads.filter((entry) => entry.startsWith('GET '))).toHaveLength(0);
      expect(ownerApplyRequests).toBe(4);
      expect(recoveryRequests).toBe(0);
      expect(pageApiMutationRequests).toBe(4);
      expect(anonymousPageProbeRequests).toBe(1);
      expect(embeddingRequests).toBe(3);
      const fixtureCalls = await db.execute<{ model: string; role: string }>(
        sql`SELECT model, role FROM model_calls WHERE model = ${BASIC5_FIXTURE_MODEL_ID}`,
      );
      expect(fixtureCalls).toHaveLength(3);
      const foreignCalls = await db.execute<{ model: string }>(
        sql`SELECT model FROM model_calls WHERE model <> ${BASIC5_FIXTURE_MODEL_ID}`,
      );
      expect(foreignCalls).toHaveLength(0);
      fixtureModelCallCount = fixtureCalls.length;
      foreignModelCallCount = foreignCalls.length;
      expect(browserBudgetExceeded).toBe(false);
      expect(browserHttpRequests).toBeLessThanOrEqual(BASIC5_BROWSER_TOTAL_REQUEST_LIMIT);
      expect(browserDynamicHttpRequests).toBeLessThanOrEqual(BASIC5_BROWSER_DYNAMIC_REQUEST_LIMIT);
      expect(browserStaticAssetRequests).toBeLessThanOrEqual(
        BASIC5_BROWSER_STATIC_ASSET_REQUEST_LIMIT,
      );
      expect(browserHttpRequests).toBe(browserDynamicHttpRequests + browserStaticAssetRequests);
      expect(readinessAttempts).not.toBeNull();
      expect(readinessAttempts).toBeLessThanOrEqual(BASIC5_READINESS_ATTEMPT_LIMIT);
      expect(authenticatedPageNavigations).toBe(6);
      if (processRegistry) assertBasic5CiProcessRegistryComplete(await processRegistry.records());
      setCheckpoint('case_complete');
    } catch (error) {
      testError = error;
    }
    // Diagnostic listeners cannot replace the original test result or cleanup.
    try {
      stopRequestFailureObservation?.();
    } catch {
      /* observational only */
    }
    const cleanupErrors: unknown[] = [];
    const cleanup = {
      browserClosed: !browser,
      standaloneProcessGroupExited: !webProcess,
      embeddingServerClosed: !embeddingServer,
      databasePoolClosed: false,
      temporaryHomeRemoved: !emptyHome,
    };
    if (browser) {
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          browser.close(),
          new Promise<void>((_, reject) => {
            closeTimer = setTimeout(
              () =>
                reject(new Error('Playwright browser did not close within its bounded deadline.')),
              BROWSER_CLOSE_TIMEOUT_MS,
            );
          }),
        ]);
        cleanup.browserClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    }
    if (webProcess) {
      try {
        await stopOwnedProcess(webProcess);
        cleanup.standaloneProcessGroupExited = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (embeddingServer) {
      try {
        await closeServer(embeddingServer);
        cleanup.embeddingServerClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    // The separately reviewed supervisor owns target cleanup after verifying
    // child-group exit. This case closes only its own database connections.
    try {
      await db.$client.end({ timeout: 5 });
      cleanup.databasePoolClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (emptyHome) {
      try {
        await rm(emptyHome, { recursive: true, force: true });
        cleanup.temporaryHomeRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const result = testError || cleanupErrors.length > 0 ? 'failed' : 'passed';
    emitCheckpoint();
    process.stdout.write(
      `${EVIDENCE_PREFIX}${JSON.stringify({
        schemaVersion: 1,
        label: 'synthetic Auth.js cookie; provider-unqualified local embedding transport',
        result,
        fixture: fixtureManifest,
        standalone: {
          sourceCommit: process.env.ASSISTANT_BASIC5_STANDALONE_SOURCE_SHA ?? null,
          buildId: process.env.ASSISTANT_BASIC5_STANDALONE_BUILD_ID ?? null,
          serverSha256: process.env.ASSISTANT_BASIC5_STANDALONE_SERVER_SHA256 ?? null,
        },
        executionEnvironment,
        receipts: receipts.map((receipt) => ({
          authority: receipt.authority,
          command: receipt.command,
          operationId: receipt.operationId,
          requestHash: receipt.requestHash,
          statusVersion: receipt.statusVersion,
          outcome: receipt.outcome,
          ids: receipt.ids ?? null,
        })),
        durableReadbacks,
        counts: {
          readinessAttempts,
          pageNavigations: authenticatedPageNavigations,
          authenticatedPageNavigations,
          browserHttpRequests,
          browserDynamicHttpRequests,
          browserStaticAssetRequests,
          browserPageHttpRequests: browserHttpRequests - anonymousPageProbeRequests,
          anonymousPageProbeRequests,
          pageApiMutationRequests,
          applyPosts: receipts.length,
          ownerEditorPostCount,
          ownerApplyRequests,
          recoveryGets: ownerEditorGetCount,
          recoveryRequests,
          embeddingRequests,
          fixtureModelCalls: fixtureModelCallCount,
          foreignModelCalls: foreignModelCallCount,
          providerRequests: {
            localEmbeddingHttpRequests: embeddingRequests,
            fixtureModelCallRows: fixtureModelCallCount,
            nonFixtureModelCallRows: foreignModelCallCount,
          },
        },
        cleanup,
        externalCleanupSupervisorRequired: true,
        standardTestWrapperCleanupIsUnconditional: true,
        testFailure: testError ? 'test_failed' : null,
        cleanupFailure: cleanupErrors.length > 0 ? 'cleanup_incomplete' : null,
      })}\n`,
    );
    if (testError && cleanupErrors.length > 0)
      throw new AggregateError(
        [testError, ...cleanupErrors],
        'BASIC5 acceptance and cleanup failed',
      );
    if (testError) throw testError;
    if (cleanupErrors.length > 0)
      throw new AggregateError(cleanupErrors, 'BASIC5 acceptance cleanup was incomplete');
  },
  180_000,
);
