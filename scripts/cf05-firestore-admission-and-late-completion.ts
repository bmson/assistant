import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskLease } from '@assistant/persistence';
import { Firestore } from '@google-cloud/firestore';
import { seedContextWithEvidence } from '../packages/core/src/workflow/executor/seed.js';
import { FirestoreApplicationChatPersistence } from '../packages/firestore/src/application-chat.js';
import { FirestoreExecutionContextRepository } from '../packages/firestore/src/execution-context.js';
import { assertFirestoreInstallationOwner } from '../packages/firestore/src/installation-owner.js';
import { decodeRecord, documentKey, InstallationStore } from '../packages/firestore/src/store.js';
import { FirestoreTaskLeaseRepository } from '../packages/firestore/src/tasks.js';

const manifestPath = process.env.ASSISTANT_CHAT_ROOT_VERIFIED_MANIFEST;
const receiptPath = process.env.ASSISTANT_CHAT_RUN_RECEIPT_PATH;
const reportPath = process.env.CF05_ADAPTER_REPORT_PATH;
const expectedSha = process.env.ASSISTANT_CHAT_EXPECTED_SHA;
const expectedBranch = process.env.ASSISTANT_CHAT_EXPECTED_BRANCH;
assert(manifestPath && receiptPath && reportPath && expectedSha, 'Missing harness run inputs');
assert(expectedBranch, 'Missing expected managed branch');

interface AdmissionAttempt {
  body: {
    clientOperationId: string;
    conversationId: string;
    messages: Array<{ id: string; role: string; parts: Array<{ text?: string }> }>;
    autonomous?: boolean;
    force?: boolean;
    spoken?: boolean;
  };
  status: number;
  taskId: string | null;
  ownerMessageId: string | null;
}
interface RunReceipt {
  schemaVersion: number;
  sourceSha: string;
  installationId: string;
  ownerId: string;
  conversations: { replay: string; queue: string };
  admissions: {
    retryCommitted: AdmissionAttempt;
    retryReplay: AdmissionAttempt;
    intentionalDuplicate: AdmissionAttempt;
    queuedA: AdmissionAttempt;
    queuedB: AdmissionAttempt;
  };
}
interface Attestation {
  firestoreEmulatorHost: string;
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  installationId: string;
  ownerId: string;
  sourceRoot: string;
  sourceBranch: string;
  sourceCommit: string;
  sourceTreeClean: boolean;
  appSha: string;
  serverWorkingDirectory: string;
  verificationStatus: string;
  verifiedAt: string;
}

function getAttempt(value: AdmissionAttempt | undefined, label: string) {
  assert(value, `${label}: browser receipt missing`);
  assert.equal(value.status, 200, `${label}: route did not accept admission`);
  assert(value.taskId, `${label}: missing task receipt`);
  assert(value.ownerMessageId, `${label}: missing owner-message receipt`);
  const [message] = value.body.messages;
  assert(message, `${label}: missing triggering request message`);
  const text = message.parts?.map((part) => part.text ?? '').join('') ?? '';
  assert.equal(message.role, 'user');
  assert(text.startsWith('Schedule'), `${label}: fixture text must take the no-model action route`);
  return {
    taskId: value.taskId,
    messageId: value.ownerMessageId,
    requestMessageId: message.id,
    text,
  };
}

const attestation = JSON.parse(await readFile(manifestPath, 'utf8')) as Attestation;
const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as RunReceipt;
assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.sourceSha, expectedSha);
assert.equal(receipt.installationId, attestation.installationId);
assert.equal(receipt.ownerId, attestation.ownerId);
assert.equal(attestation.sourceCommit, expectedSha);
assert.equal(attestation.appSha, expectedSha);
assert.equal(attestation.sourceBranch, expectedBranch);
assert.equal(attestation.sourceTreeClean, true);
assert.equal(attestation.verificationStatus, 'root-verified');
const verifiedAt = Date.parse(attestation.verifiedAt);
assert(Number.isFinite(verifiedAt), 'The root verification timestamp is required');
assert(Math.abs(Date.now() - verifiedAt) <= 5 * 60_000, 'Root verification must be fresh');
const sourceRoot = resolve(attestation.sourceRoot);
const serverWorkingDirectory = resolve(attestation.serverWorkingDirectory);
assert.equal(
  sourceRoot,
  resolve(process.cwd()),
  'The root-verified source must match this fixture checkout',
);
assert(sourceRoot.includes('/.codex/worktrees/'), 'Use the selected managed worktree for CF-05');
assert(!sourceRoot.endsWith('/Code/Personal/assistant'), 'The primary checkout is forbidden');
assert(
  serverWorkingDirectory === sourceRoot ||
    serverWorkingDirectory === resolve(sourceRoot, 'apps/web'),
  'The app must run from the selected worktree root or its web app directory',
);
assert.match(attestation.firestoreEmulatorHost, /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/i);
assert(
  attestation.firestoreProjectId.startsWith('demo-'),
  'Use a dedicated Firestore emulator project',
);
assert(attestation.firestoreDatabaseId, 'The emulator database ID must be explicit');

const admissions = [
  ['retryCommitted', receipt.admissions.retryCommitted],
  ['retryReplay', receipt.admissions.retryReplay],
  ['intentionalDuplicate', receipt.admissions.intentionalDuplicate],
  ['queuedA', receipt.admissions.queuedA],
  ['queuedB', receipt.admissions.queuedB],
] as const;
const requestFacts = {
  retryCommitted: getAttempt(receipt.admissions.retryCommitted, 'retryCommitted'),
  retryReplay: getAttempt(receipt.admissions.retryReplay, 'retryReplay'),
  intentionalDuplicate: getAttempt(receipt.admissions.intentionalDuplicate, 'intentionalDuplicate'),
  queuedA: getAttempt(receipt.admissions.queuedA, 'queuedA'),
  queuedB: getAttempt(receipt.admissions.queuedB, 'queuedB'),
};
assert.equal(requestFacts.retryCommitted.taskId, requestFacts.retryReplay.taskId);
assert.equal(requestFacts.retryCommitted.messageId, requestFacts.retryReplay.messageId);
assert.equal(
  requestFacts.retryCommitted.requestMessageId,
  requestFacts.retryReplay.requestMessageId,
);
assert.notEqual(requestFacts.retryCommitted.taskId, requestFacts.intentionalDuplicate.taskId);
assert.notEqual(requestFacts.retryCommitted.messageId, requestFacts.intentionalDuplicate.messageId);
assert.notEqual(requestFacts.queuedA.taskId, requestFacts.queuedB.taskId);
assert.notEqual(requestFacts.queuedA.messageId, requestFacts.queuedB.messageId);

process.env.FIRESTORE_EMULATOR_HOST = attestation.firestoreEmulatorHost;
let clock = new Date();
const firestore = new Firestore({
  projectId: attestation.firestoreProjectId,
  databaseId: attestation.firestoreDatabaseId,
});
const store = new InstallationStore(
  firestore,
  attestation.installationId,
  () => new Date(clock),
  attestation.firestoreProjectId,
  attestation.firestoreDatabaseId,
);
try {
  const verifiedOwner = await assertFirestoreInstallationOwner(store, attestation.ownerId);
  assert.equal(verifiedOwner, attestation.ownerId);
  const conversationIds = new Set([receipt.conversations.replay, receipt.conversations.queue]);
  for (const conversationId of conversationIds) {
    const conversation = await store.doc('conversations', conversationId).get();
    assert(conversation.exists, `Missing conversation ${conversationId}`);
    assert.equal(conversation.get('id'), conversationId);
    assert.equal(conversation.get('agentId'), attestation.ownerId);
  }

  const linkReport: Array<Record<string, unknown>> = [];
  const tasksByLabel = new Map<string, TaskLease>();
  for (const [label, attempt] of admissions) {
    const facts = requestFacts[label];
    const taskSnapshot = await store.doc('tasks', facts.taskId).get();
    assert(taskSnapshot.exists, `${label}: persisted task missing`);
    const task = decodeRecord<TaskLease>(taskSnapshot.data());
    const trigger = task.trigger as {
      source?: unknown;
      agentId?: unknown;
      conversationId?: unknown;
      trust?: unknown;
      payload?: Record<string, unknown>;
    };
    const payload = trigger.payload;
    const chatAdmission = payload?.chatAdmission as Record<string, unknown> | undefined;
    assert.equal(task.id, facts.taskId);
    assert.equal(documentKey(task.id), taskSnapshot.id);
    assert.equal(task.agentId, attestation.ownerId);
    assert.equal(task.type, 'chat_turn');
    assert.equal(task.trust, 'owner');
    assert.equal(task.conversationId, attempt.body.conversationId);
    assert.equal(
      task.status,
      'pending',
      `${label}: a worker ran despite the local-queue/no-worker profile`,
    );
    assert.equal(trigger.source, 'chat');
    assert.equal(trigger.agentId, attestation.ownerId);
    assert.equal(trigger.conversationId, task.conversationId);
    assert.equal(trigger.trust, 'owner');
    assert.equal(payload?.text, facts.text);
    assert.equal(payload?.triggerMessageId, facts.messageId);
    assert.equal(chatAdmission?.protocol, 'owner-chat-v1');
    assert.equal(chatAdmission?.clientOperationId, attempt.body.clientOperationId);
    assert.equal(chatAdmission?.triggerMessageId, facts.messageId);
    assert.equal(chatAdmission?.phase, 'queued');
    assert.equal(
      task.externalEventId,
      `chat-admission:${attestation.ownerId}:${task.conversationId}:${attempt.body.clientOperationId}`,
    );
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify([
          facts.text,
          attempt.body.autonomous === true,
          attempt.body.force === true,
          attempt.body.spoken === true,
        ]),
      )
      .digest('hex');
    assert.equal(
      chatAdmission?.requestHash,
      expectedHash,
      `${label}: request hash is not tied to exact submitted args`,
    );

    const messageSnapshot = await store.doc('messages', facts.messageId).get();
    assert(messageSnapshot.exists, `${label}: persisted owner message missing`);
    const message = decodeRecord<Record<string, unknown>>(messageSnapshot.data());
    assert.equal(message.id, facts.messageId);
    assert.equal(message.conversationId, task.conversationId);
    assert.equal(message.taskId, task.id);
    assert.equal(message.role, 'user');
    assert.equal(message.origin, 'owner');
    assert.equal(message.hiddenAt, null);
    assert.equal(message.text, facts.text);
    assert.equal(
      facts.requestMessageId,
      attempt.body.clientOperationId,
      `${label}: route request message ID differs from the send operation ID`,
    );

    if (label === 'queuedA' || label === 'queuedB') tasksByLabel.set(label, task);
    linkReport.push({
      label,
      taskId: task.id,
      messageId: facts.messageId,
      conversationId: task.conversationId,
      requestHashVerified: true,
      status: task.status,
    });
  }

  const taskA = tasksByLabel.get('queuedA');
  const taskB = tasksByLabel.get('queuedB');
  assert(taskA && taskB);
  assert.equal(taskA.conversationId, taskB.conversationId);
  const leaseRepo = new FirestoreTaskLeaseRepository(store);
  const chatRepo = new FirestoreApplicationChatPersistence(store, attestation.ownerId);
  const contextRepo = new FirestoreExecutionContextRepository(store);
  const leaseA1 = await leaseRepo.claim(taskA.id, taskA.queueGeneration);
  assert(leaseA1, 'A must be claimed first to model the slow earlier worker');
  clock = new Date(clock.getTime() + 11 * 60_000);
  const leaseB = await leaseRepo.claim(taskB.id, taskB.queueGeneration);
  assert(leaseB, 'B must be claimable while A is delayed');

  const seedA = await seedContextWithEvidence(contextRepo, leaseA1 as never);
  const seedB = await seedContextWithEvidence(contextRepo, leaseB as never);
  const userTexts = (seed: typeof seedA) =>
    seed.messages
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string' ? message.content : ''));
  assert(userTexts(seedA).includes(requestFacts.queuedA.text));
  assert(
    !userTexts(seedA).includes(requestFacts.queuedB.text),
    'A seed crossed its own persisted trigger boundary',
  );
  assert.equal(userTexts(seedA).at(-1), requestFacts.queuedA.text);
  assert(userTexts(seedB).includes(requestFacts.queuedB.text));
  assert.equal(userTexts(seedB).at(-1), requestFacts.queuedB.text);

  const resultMessage = (task: TaskLease, text: string) => ({
    conversationId: task.conversationId as string,
    taskId: task.id,
    role: 'assistant' as const,
    origin: 'assistant' as const,
    parts: [{ type: 'text', text }],
    text,
  });
  assert.equal(
    await chatRepo.completeDirectChatTask({
      agentId: attestation.ownerId,
      task: leaseB,
      status: 'done',
      progress: 'Synthetic local worker result B',
      messages: [resultMessage(leaseB, `Result B for: ${requestFacts.queuedB.text}`)],
    }),
    true,
    'B should complete before the delayed A lease is reclaimed',
  );

  // Advance the adapter clock beyond A1's lease, then reclaim A through the real adapter.
  clock = new Date(clock.getTime() + 11 * 60_000);
  const leaseA2 = await leaseRepo.claim(taskA.id, taskA.queueGeneration);
  assert(leaseA2 && leaseA2.leaseToken !== leaseA1.leaseToken);
  const staleWrite = await chatRepo.completeDirectChatTask({
    agentId: attestation.ownerId,
    task: leaseA1,
    status: 'done',
    progress: 'This stale synthetic result must be rejected',
    messages: [resultMessage(leaseA1, 'STALE A RESULT MUST NOT APPEAR')],
  });
  assert.equal(staleWrite, false, 'A late result from the superseded lease must be fenced');
  const currentWrite = await chatRepo.completeDirectChatTask({
    agentId: attestation.ownerId,
    task: leaseA2,
    status: 'done',
    progress: 'Synthetic local worker result A after reclaim',
    messages: [resultMessage(leaseA2, `Result A for: ${requestFacts.queuedA.text}`)],
  });
  assert.equal(currentWrite, true);

  const conversationMessages = await store
    .collection('messages')
    .where('conversationId', '==', taskA.conversationId)
    .get();
  const persistedResults = conversationMessages.docs
    .map((doc) => decodeRecord<Record<string, unknown>>(doc.data()))
    .filter(
      (message) =>
        message.role === 'assistant' &&
        (message.taskId === taskA.id || message.taskId === taskB.id),
    );
  assert.equal(persistedResults.filter((message) => message.taskId === taskA.id).length, 1);
  assert.equal(persistedResults.filter((message) => message.taskId === taskB.id).length, 1);
  assert(!persistedResults.some((message) => message.text === 'STALE A RESULT MUST NOT APPEAR'));
  const resultByTask = new Map(
    persistedResults.map((message) => [String(message.taskId), message]),
  );
  assert.equal(resultByTask.get(taskA.id)?.text, `Result A for: ${requestFacts.queuedA.text}`);
  assert.equal(resultByTask.get(taskB.id)?.text, `Result B for: ${requestFacts.queuedB.text}`);

  const report = {
    status: 'firestore-admission-linkage-and-late-lease-fence-exercised',
    sourceSha: expectedSha,
    persistence: 'firestore-emulator-loopback',
    providerCalls: 0,
    workerProcessesStarted: 0,
    ownerScope: 'single-attested-installation-owner-verified',
    persistedAdmissions: linkReport,
    order: [
      'claim A lease 1',
      'advance adapter clock beyond lease',
      'claim and complete B',
      'reclaim A lease 2',
      'reject stale A1 completion',
      'accept current A2 completion',
    ],
    lateCompletion: {
      staleLeaseRejected: true,
      staleAssistantRows: 0,
      currentLeaseAccepted: true,
      resultRowsTaskBound: true,
    },
    caveat:
      'Synthetic adapter completions exercise Firestore task/message lease fences; they are not a full provider-backed worker execution.',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(
    JSON.stringify({
      status: report.status,
      sourceSha: expectedSha,
      persistedAdmissionCount: linkReport.length,
      lateCompletion: report.lateCompletion,
    }),
  );
} finally {
  await firestore.terminate();
}
