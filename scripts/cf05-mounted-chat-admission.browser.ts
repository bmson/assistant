/**
 * CF-05 mounted-browser admission subset against the real web page and route.
 *
 * Run only against a verified loopback app backed by a Firestore emulator and
 * with QUEUE_DRIVER=local and a configured priced draft
 * route. The two requests begin with “Schedule”, so chat's deterministic action
 * gate queues them without invoking a model or provider. The local queue notifier
 * is intentionally a no-op; no worker should be attached during this test.
 *
 * ASSISTANT_CHAT_BASE_URL must point at that already-running isolated app. The
 * fixture launches Chromium but does not start the app, emulator, database, or worker.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page, type Route } from 'playwright';

const configuredBaseUrl = process.env.ASSISTANT_CHAT_BASE_URL;
assert(configuredBaseUrl, 'Set ASSISTANT_CHAT_BASE_URL to the isolated loopback app');
const baseUrl = new URL(configuredBaseUrl);
assert.equal(baseUrl.protocol, 'http:', 'Use the local HTTP listener for this fixture');
const manifestPath = process.env.ASSISTANT_CHAT_ROOT_VERIFIED_MANIFEST;
assert(
  manifestPath,
  'Set ASSISTANT_CHAT_ROOT_VERIFIED_MANIFEST to the root-verified isolated-run profile',
);
const expectedSha = process.env.ASSISTANT_CHAT_EXPECTED_SHA;
const expectedBranch = process.env.ASSISTANT_CHAT_EXPECTED_BRANCH;
const receiptPath = process.env.ASSISTANT_CHAT_RUN_RECEIPT_PATH;
assert(receiptPath, 'Set ASSISTANT_CHAT_RUN_RECEIPT_PATH to a private output file');
assert(expectedBranch, 'Set ASSISTANT_CHAT_EXPECTED_BRANCH to the selected managed branch');
assert.match(
  expectedSha ?? '',
  /^[0-9a-f]{40}$/i,
  'Set ASSISTANT_CHAT_EXPECTED_SHA to the exact local source SHA',
);
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
assert(isLoopback, 'ASSISTANT_CHAT_BASE_URL must use localhost, 127.0.0.1, or ::1');

interface RootVerifiedRunManifest {
  baseUrl: string;
  appSha: string;
  persistenceDriver: string;
  firestoreEmulatorHost: string;
  installationId: string;
  ownerId: string;
  queueDriver: string;
  sourceRoot: string;
  sourceBranch: string;
  sourceCommit: string;
  sourceTreeClean: boolean;
  serverPid: number;
  serverCommandSha256: string;
  serverWorkingDirectory: string;
  isolatedDatabaseConfirmed: boolean;
  noWorkerAttached: boolean;
  providerCallsDisabled: boolean;
  verificationStatus: string;
  verifiedAt: string;
}

interface AdmissionAttempt {
  body: {
    clientOperationId: string;
    conversationId: string;
    messages: Array<{ id: string; role: string; parts: Array<{ text?: string }> }>;
  };
  status: number;
  taskId: string | null;
  ownerMessageId: string | null;
}

async function verifyIsolatedProfile(): Promise<RootVerifiedRunManifest> {
  const attestation = JSON.parse(
    await readFile(manifestPath as string, 'utf8'),
  ) as RootVerifiedRunManifest;
  assert.match(
    attestation.firestoreEmulatorHost,
    /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/i,
    'Firestore must target a loopback emulator, never a hosted project',
  );
  assert.equal(attestation.baseUrl.replace(/\/$/, ''), baseUrl.origin);
  assert.equal(attestation.appSha, expectedSha);
  assert.equal(attestation.sourceCommit, expectedSha);
  assert.equal(attestation.sourceBranch, expectedBranch);
  assert(attestation.sourceRoot.includes('/.codex/worktrees/'));
  assert(!attestation.sourceRoot.endsWith('/Code/Personal/assistant'));
  assert.equal(attestation.sourceTreeClean, true);
  assert(Number.isSafeInteger(attestation.serverPid) && attestation.serverPid > 0);
  assert.match(attestation.serverCommandSha256, /^[0-9a-f]{64}$/i);
  const sourceRoot = resolve(attestation.sourceRoot);
  const serverWorkingDirectory = resolve(attestation.serverWorkingDirectory);
  assert(
    serverWorkingDirectory === sourceRoot ||
      serverWorkingDirectory === resolve(sourceRoot, 'apps/web'),
    'The app must run from the selected worktree root or its web app directory',
  );
  assert.equal(attestation.persistenceDriver, 'firestore');
  assert.equal(attestation.queueDriver, 'local');
  assert.match(
    attestation.installationId,
    /^cf05-[a-zA-Z0-9_-]{8,128}$/i,
    'Use a dedicated CF-05 test installation identity',
  );
  assert.match(attestation.ownerId, /^[0-9a-f-]{36}$/i);
  assert.equal(attestation.isolatedDatabaseConfirmed, true);
  assert.equal(attestation.noWorkerAttached, true);
  assert.equal(attestation.providerCallsDisabled, true);
  assert.equal(attestation.verificationStatus, 'root-verified');
  const verifiedAt = Date.parse(attestation.verifiedAt);
  assert(Number.isFinite(verifiedAt), 'The root verification timestamp is required');
  assert(Math.abs(Date.now() - verifiedAt) <= 5 * 60_000, 'Root verification must be fresh');

  const health = await fetch(new URL('/api/health', baseUrl));
  assert.equal(health.status, 200, 'The local app must expose its source SHA');
  const body = (await health.json()) as { sha?: unknown };
  assert.equal(
    body.sha,
    expectedSha,
    'Running app source must match the explicitly selected commit',
  );
  return attestation;
}

async function createConversation(page: Page): Promise<string> {
  await page.goto(new URL('/chat', baseUrl).toString());
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/mobile/v1/chats', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 201, 'The local owner session must be able to create a test chat');
  assert.match(result.body.conversationId, /^[0-9a-f-]{36}$/i);
  return result.body.conversationId as string;
}

async function openChat(page: Page, conversationId: string): Promise<void> {
  await page.goto(new URL(`/chat/${conversationId}`, baseUrl).toString());
  await page.getByRole('textbox').waitFor();
}

function captureAdmissions(page: Page, options: { dropFirstResponse?: boolean } = {}) {
  const attempts: AdmissionAttempt[] = [];
  let dropped = false;
  const handler = async (route: Route) => {
    const request = route.request();
    const body = request.postDataJSON() as AdmissionAttempt['body'];
    const response = await route.fetch();
    const headers = response.headers();
    const status = response.status();
    attempts.push({
      body,
      status,
      taskId: headers['x-async-task'] ?? null,
      ownerMessageId: headers['x-owner-message-id'] ?? null,
    });

    if (options.dropFirstResponse && !dropped) {
      dropped = true;
      // The application response already committed before this test proxy
      // reports a transport failure to the mounted client.
      await response.body();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The test proxy dropped the committed receipt.' }),
      });
      return;
    }
    await route.fulfill({ response });
  };
  const installed = page.route('**/api/chat', handler);
  return {
    attempts,
    async ready(): Promise<void> {
      await installed;
    },
    async remove(): Promise<void> {
      await page.unroute('**/api/chat', handler);
    },
  };
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function waitForAdmission(attempts: AdmissionAttempt[], count: number) {
  // Playwright route callbacks execute in Node, so wait on the recorded receipt
  // there instead of publishing test state into the product page.
  const deadline = Date.now() + 20_000;
  while (attempts.length < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(attempts.length, count, `Expected ${count} actual /api/chat request(s)`);
}

async function sendAndWait(page: Page, text: string, attempts: AdmissionAttempt[]) {
  await send(page, text);
  await waitForAdmission(attempts, 1);
  assert.equal(attempts[0]?.status, 200, 'The actual chat route should accept the request');
  assert.ok(attempts[0]?.taskId, 'Accepted action turns return the durable task receipt');
  assert.ok(attempts[0]?.ownerMessageId, 'Accepted turns return the durable owner-message receipt');
  return attempts[0] as AdmissionAttempt;
}

const attestation = await verifyIsolatedProfile();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const pages: Page[] = [];
const passed: string[] = [];
try {
  const seed = await context.newPage();
  pages.push(seed);
  const replayConversation = await createConversation(seed);
  const firstPage = await context.newPage();
  const intentionalPage = await context.newPage();
  pages.push(firstPage, intentionalPage);
  // Both clients load before either send, so the second composer represents a
  // distinct intentional owner send rather than a stale task already in view.
  await Promise.all([
    openChat(firstPage, replayConversation),
    openChat(intentionalPage, replayConversation),
  ]);
  const first = captureAdmissions(firstPage, { dropFirstResponse: true });
  const second = captureAdmissions(intentionalPage);
  await Promise.all([first.ready(), second.ready()]);

  const sameText = 'Schedule the CF-05 local acceptance check for Friday at noon.';
  await send(firstPage, sameText);
  await waitForAdmission(first.attempts, 1);
  assert.equal(first.attempts[0]?.status, 200);
  assert.ok(first.attempts[0]?.taskId);
  await firstPage.getByRole('alert').waitFor();
  await firstPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await waitForAdmission(first.attempts, 2);
  assert.equal(first.attempts[1]?.status, 200);

  const replayAttempt = first.attempts[1] as AdmissionAttempt;
  assert.equal(first.attempts[0]?.body.conversationId, replayConversation);
  assert.equal(replayAttempt.body.clientOperationId, first.attempts[0]?.body.clientOperationId);
  assert.equal(replayAttempt.body.messages[0]?.id, first.attempts[0]?.body.messages[0]?.id);
  assert.equal(replayAttempt.body.messages[0]?.parts[0]?.text, sameText);
  assert.equal(replayAttempt.taskId, first.attempts[0]?.taskId);
  assert.equal(replayAttempt.ownerMessageId, first.attempts[0]?.ownerMessageId);

  const intentionalReceipt = await sendAndWait(intentionalPage, sameText, second.attempts);
  assert.equal(intentionalReceipt.body.conversationId, replayConversation);
  assert.notEqual(intentionalReceipt.body.clientOperationId, replayAttempt.body.clientOperationId);
  assert.notEqual(intentionalReceipt.taskId, replayAttempt.taskId);
  assert.notEqual(intentionalReceipt.ownerMessageId, replayAttempt.ownerMessageId);
  const replayTranscript = await context.newPage();
  pages.push(replayTranscript);
  await openChat(replayTranscript, replayConversation);
  const replayOwners = replayTranscript.locator('[data-message-block="true"][data-role="user"]');
  const matchingReplayRows = replayOwners.filter({ hasText: sameText });
  const replayRowDeadline = Date.now() + 10_000;
  while ((await matchingReplayRows.count()) !== 2 && Date.now() < replayRowDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    await matchingReplayRows.count(),
    2,
    'The retry persists one owner message and the intentional duplicate persists one more',
  );
  passed.push(
    'Mounted ChatClient retries a committed, lost /api/chat receipt with the same operation/message/task identity; an identical intentional send receives a fresh identity and distinct durable receipts.',
  );

  const queueConversation = await createConversation(seed);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  pages.push(pageA, pageB);
  await Promise.all([openChat(pageA, queueConversation), openChat(pageB, queueConversation)]);
  const captureA = captureAdmissions(pageA);
  const captureB = captureAdmissions(pageB);
  await Promise.all([captureA.ready(), captureB.ready()]);
  const textA = 'Schedule CF-05 queued request A for Friday at noon.';
  const textB = 'Schedule CF-05 queued request B for Monday at noon.';
  const [receiptA, receiptB] = await Promise.all([
    sendAndWait(pageA, textA, captureA.attempts),
    sendAndWait(pageB, textB, captureB.attempts),
  ]);
  assert.equal(receiptA.body.conversationId, queueConversation);
  assert.equal(receiptB.body.conversationId, queueConversation);
  assert.notEqual(receiptA.body.clientOperationId, receiptB.body.clientOperationId);
  assert.notEqual(receiptA.taskId, receiptB.taskId);
  assert.equal(receiptA.body.messages[0]?.parts[0]?.text, textA);
  assert.equal(receiptB.body.messages[0]?.parts[0]?.text, textB);

  const transcript = await context.newPage();
  pages.push(transcript);
  await openChat(transcript, queueConversation);
  const owners = transcript.locator('[data-message-block="true"][data-role="user"]');
  const textARows = owners.filter({ hasText: textA });
  const textBRows = owners.filter({ hasText: textB });
  const transcriptDeadline = Date.now() + 10_000;
  while (
    ((await textARows.count()) !== 1 || (await textBRows.count()) !== 1) &&
    Date.now() < transcriptDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await textARows.count(), 1);
  assert.equal(await textBRows.count(), 1);
  passed.push(
    'Admission subset: two mounted clients queued A and B before local execution; route receipts and the reloaded transcript preserve distinct operation/task IDs and each submitted text.',
  );

  const runReceipt = {
    schemaVersion: 1,
    sourceSha: expectedSha,
    installationId: attestation.installationId,
    ownerId: attestation.ownerId,
    conversations: { replay: replayConversation, queue: queueConversation },
    admissions: {
      retryCommitted: first.attempts[0],
      retryReplay: first.attempts[1],
      intentionalDuplicate: second.attempts[0],
      queuedA: captureA.attempts[0],
      queuedB: captureB.attempts[0],
    },
  };
  await writeFile(receiptPath, `${JSON.stringify(runReceipt, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });

  console.log(
    JSON.stringify(
      {
        status: 'mounted-browser-admission-subset-exercised',
        cf05Acceptance: 'partial',
        sourceSha: expectedSha,
        profile: {
          persistenceDriver: 'firestore',
          emulator: 'loopback',
          queueDriver: 'local',
          installationId: 'attested',
          ownerId: 'attested',
        },
        exercised: passed,
        stillOpen: [
          'Inspect the stored task.triggerMessageId/requestHash and message-task linkage through a trusted local adapter harness.',
          'Execute queued B before A and prove each worker uses its own immutable trigger.',
          'Deliver late worker receipts/results and verify they cannot overwrite newer turns or cause duplicate effects.',
          'Complete all remaining CF-05/F16 acceptance beyond this mounted admission subset.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
  await context.close();
  await browser.close();
}
