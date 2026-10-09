import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import {
  createFirestoreCardRefreshRepository,
  createFirestoreExecutionPersistence,
  createFirestoreProfileMemoryCommandPersistence,
  embeddingSpaceKey,
  FirestoreApplicationChatPersistence,
  FirestoreGeneratedCardRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  type Records,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { createProfileMemoryCommands } from '../packages/application/src/profile/memory-commands.js';

const APPLICATION_SMOKE_SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'application-smoke',
  dimensions: 1536,
  revision: '1',
};

function smokeMemory(
  id: string,
  agentId: string,
  subjectContactId: string,
  content: string,
  createdAt: Date,
): Records['memories'] {
  return {
    id,
    agentId,
    createdAt,
    expiresAt: null,
    embedding: [1, ...new Array(APPLICATION_SMOKE_SPACE.dimensions - 1).fill(0)],
    embeddingSpaceKey: embeddingSpaceKey(APPLICATION_SMOKE_SPACE),
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.90',
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 5,
    quarantined: false,
    subjectContactId,
    domain: 'home',
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'synthetic-smoke',
    lastAccessedAt: null,
    lastConsolidatedAt: null,
  };
}

/** Synthetic application-query smoke shared by emulator CI and real-cloud validation. */
export async function firestoreApplicationSmoke(
  store: InstallationStore,
): Promise<{ profileMemoryCommands: 'passed' }> {
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const now = new Date();
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic owner',
    timezone: 'UTC',
    createdAt: now,
    updatedAt: now,
  });
  const execution = createFirestoreExecutionPersistence(store, agentId, APPLICATION_SMOKE_SPACE);
  assert.equal(execution.driver, 'firestore');
  assert.equal(execution.memorySupersede.kind, 'memory-supersede-repository');
  assert.equal(execution.ownerCardCompilation.kind, 'owner-card-compilation-repository');
  assert.equal(execution.ownerContext.kind, 'owner-context-repository');

  const ownerContactId = randomUUID();
  await store.doc('contacts', ownerContactId).set({
    id: ownerContactId,
    name: 'Synthetic owner',
    aliases: [],
    emails: [],
    phones: [],
    relationship: '',
    trust: 'owner',
    notes: '',
    createdAt: now,
    updatedAt: now,
  });
  const oldFact = smokeMemory(
    randomUUID(),
    agentId,
    ownerContactId,
    'Synthetic owner lives in Oldtown',
    new Date(now.getTime() - 1_000),
  );
  const replacement = smokeMemory(
    randomUUID(),
    agentId,
    ownerContactId,
    'Synthetic owner lives in Newtown',
    now,
  );
  for (const memory of [oldFact, replacement]) {
    await store.doc('memories', memory.id).set({
      ...memory,
      embedding: FieldValue.vector(memory.embedding as number[]),
      embeddingSpace: embeddingSpaceKey(APPLICATION_SMOKE_SPACE),
      retrievalRevision: randomUUID(),
    });
    await store
      .doc('memoryContentHashes', memory.contentHash)
      .set({ memoryId: memory.id, createdAt: now });
  }
  const compiled = await compileOwnerCard(execution.ownerCardCompilation, agentId, now);
  assert.match(compiled, /Oldtown/);
  assert.match(compiled, /Newtown/);
  assert.deepEqual(
    await execution.memorySupersede.retire({
      agentId,
      replacementId: replacement.id,
      ids: [oldFact.id],
    }),
    [oldFact.id],
  );
  assert.equal((await execution.ownerContext.getOwnerCard(agentId))?.content, '');
  const recompiled = await compileOwnerCard(execution.ownerCardCompilation, agentId, now);
  assert.doesNotMatch(recompiled, /Oldtown/);
  assert.match(recompiled, /Newtown/);
  assert.equal((await execution.ownerContext.getOwnerCard(agentId))?.content, recompiled);

  const profilePersistence = createFirestoreProfileMemoryCommandPersistence(
    store,
    APPLICATION_SMOKE_SPACE,
  );
  const correctedContent = 'Synthetic owner lives in Correctedtown';
  const correctedHash = createHash('sha256').update(correctedContent).digest('hex');
  let embeddingAvailable = false;
  const profileCommands = createProfileMemoryCommands(profilePersistence, {
    async embed() {
      if (!embeddingAvailable) throw new Error('synthetic embedding failure');
      return [[0, 1, ...new Array(APPLICATION_SMOKE_SPACE.dimensions - 2).fill(0)]];
    },
    async embedWithIdentity(texts: string[]) {
      if (!embeddingAvailable) throw new Error('synthetic embedding failure');
      return {
        embeddings: texts.map(() => [
          0,
          1,
          ...new Array(APPLICATION_SMOKE_SPACE.dimensions - 2).fill(0),
        ]),
        embeddingSpaceKey: embeddingSpaceIdentityKey(APPLICATION_SMOKE_SPACE),
      };
    },
  });
  const tasksBeforeFailure = (await store.collection('tasks').count().get()).data().count;
  const outboxBeforeFailure = (await store.collection('outbox').count().get()).data().count;
  await assert.rejects(
    profileCommands.correctMemory(replacement.id, correctedContent),
    /synthetic embedding failure/,
  );
  assert.equal(
    (await store.doc('memories', replacement.id).get()).get('content'),
    replacement.content,
  );
  assert.equal((await store.doc('memoryTombstones', replacement.contentHash).get()).exists, false);
  assert.equal((await execution.ownerContext.getOwnerCard(agentId))?.content, recompiled);
  assert.equal((await store.collection('tasks').count().get()).data().count, tasksBeforeFailure);
  assert.equal((await store.collection('outbox').count().get()).data().count, outboxBeforeFailure);

  embeddingAvailable = true;
  assert.deepEqual(await profileCommands.correctMemory(replacement.id, correctedContent), {});
  const corrected = await store.doc('memories', replacement.id).get();
  assert.equal(corrected.get('content'), correctedContent);
  assert.equal(corrected.get('contentHash'), correctedHash);
  assert.equal(corrected.get('source'), replacement.source);
  assert.equal(corrected.get('subjectContactId'), ownerContactId);
  assert.equal(
    (await store.doc('memoryTombstones', replacement.contentHash).get()).get('reason'),
    'owner_correct',
  );
  assert.equal(
    (await store.doc('memoryContentHashes', replacement.contentHash).get()).exists,
    false,
  );
  assert.equal(
    (await store.doc('memoryContentHashes', correctedHash).get()).get('memoryId'),
    replacement.id,
  );
  const correctedCard = (await execution.ownerContext.getOwnerCard(agentId))?.content ?? '';
  assert.match(correctedCard, /Correctedtown/);
  assert.doesNotMatch(correctedCard, /Newtown/);
  const graphTasks = await store
    .collection('tasks')
    .where('agentId', '==', agentId)
    .where('trigger.payload.job', '==', 'memory.graph_sync')
    .get();
  assert.equal(graphTasks.size, 1);
  const graphTask = graphTasks.docs[0];
  assert.ok(graphTask);
  assert.match(
    String(graphTask.get('externalEventId')),
    new RegExp(`^profile:graph-sync:${replacement.id}:`),
  );
  assert.equal(
    (await store.collection('outbox').where('taskId', '==', graphTask.get('id')).limit(1).get())
      .size,
    1,
  );

  await store.doc('knowledgeGraphSources', replacement.id).set({
    memoryId: replacement.id,
    agentId,
    contentHash: correctedHash,
    subjectContactId: ownerContactId,
    status: 'ready',
    extractionVersion: 3,
    nextRetryAt: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await profileCommands.forgetMemory(replacement.id);
  assert.equal((await store.doc('memories', replacement.id).get()).exists, false);
  assert.equal((await store.doc('memoryContentHashes', correctedHash).get()).exists, false);
  assert.equal(
    (await store.doc('memoryTombstones', correctedHash).get()).get('reason'),
    'owner_forget',
  );
  assert.equal((await store.doc('knowledgeGraphSources', replacement.id).get()).exists, false);
  assert.ok(
    (await store.doc('graphDeletionIntents', replacement.id).get()).get('cleanupCompletedAt'),
  );
  assert.doesNotMatch(
    (await execution.ownerContext.getOwnerCard(agentId))?.content ?? '',
    /Correctedtown/,
  );

  const chat = new FirestoreApplicationChatPersistence(store);
  const first = await chat.createConversation(agentId);
  const second = await chat.createConversation(agentId);
  const stale = await chat.createConversation(agentId);

  const page = await chat.listConversations(agentId, { archived: false, limit: 1 });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  const nextPage = await chat.listConversations(agentId, {
    archived: false,
    limit: 2,
    after: page.nextCursor,
  });
  assert.ok(nextPage.conversations.length >= 1);
  assert.equal(await chat.countConversations(agentId, false), 3);

  const activeTaskId = randomUUID();
  await store.doc('tasks', activeTaskId).set({
    id: activeTaskId,
    agentId,
    conversationId: first.id,
    type: 'chat_turn',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  });
  assert.deepEqual(await chat.listActiveConversationIds(agentId), [first.id]);
  assert.equal(await chat.countActiveTasks(agentId, first.id), 1);
  assert.equal(await chat.archiveConversation(agentId, first.id), 'active');
  assert.equal(await chat.archiveConversation(agentId, second.id), 'archived');
  assert.equal(await chat.countConversations(agentId, true), 1);
  assert.equal(await chat.restoreConversation(agentId, second.id), true);
  await store
    .doc('conversations', stale.id)
    .update({ updatedAt: new Date('2020-01-01T00:00:00Z') });
  assert.equal(
    await chat.archiveInactiveConversations(agentId, new Date('2021-01-01T00:00:00Z')),
    1,
  );

  const runtimeTaskId = randomUUID();
  const user = await chat.appendOwned(agentId, {
    conversationId: first.id,
    taskId: runtimeTaskId,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: 'Synthetic question' }],
    text: 'Synthetic question',
  });
  const assistant = await chat.appendOwned(agentId, {
    conversationId: first.id,
    taskId: runtimeTaskId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text: 'Synthetic answer' }],
    text: 'Synthetic answer',
  });
  assert.ok(user && assistant);
  await store
    .doc('messages', assistant.id)
    .update({ createdAt: new Date(user.createdAt.getTime() + 1_000) });
  const initialMessages = await chat.listMessages(agentId, first.id, { limit: 1 });
  assert.equal(initialMessages?.messages.length, 1);
  const afterUser = await chat.listMessages(agentId, first.id, {
    limit: 2,
    after: { createdAt: user.createdAt, id: user.id },
  });
  assert.deepEqual(
    afterUser?.messages.map((message) => message.id),
    [assistant.id],
  );
  assert.deepEqual(
    (await chat.listRuntimeMessages(agentId, first.id, [runtimeTaskId]))?.map(
      (message) => message.id,
    ),
    [assistant.id],
  );
  assert.equal(await chat.setMessageHidden(agentId, first.id, assistant.id, true), true);
  assert.deepEqual(await chat.listMessagesByIds(agentId, first.id, [assistant.id]), []);
  assert.equal(await chat.setMessageHidden(agentId, first.id, assistant.id, false), true);

  const toolCallId = randomUUID();
  await store.doc('toolCalls', toolCallId).set({
    id: toolCallId,
    taskId: activeTaskId,
    toolName: 'synthetic.lookup',
    status: 'succeeded',
    step: 1,
    createdAt: now,
  });
  assert.deepEqual(await chat.listTaskActivity(agentId, first.id, activeTaskId), [
    { toolName: 'synthetic.lookup', status: 'succeeded', step: 1 },
  ]);
  await store.doc('models', 'synthetic-chat').set({
    id: 'synthetic-chat',
    label: 'Synthetic Chat',
    enabled: true,
    capabilities: {},
  });
  assert.deepEqual(await chat.listEnabledModels(), [
    { id: 'synthetic-chat', label: 'Synthetic Chat' },
  ]);

  const approvalId = randomUUID();
  const suggestionId = randomUUID();
  await store.doc('approvals', approvalId).set({
    id: approvalId,
    taskId: activeTaskId,
    summary: 'Synthetic approval',
    status: 'pending',
    payload: { safe: true },
    expiresAt: new Date(now.getTime() + 60_000),
  });
  await store.doc('suggestions', suggestionId).set({
    id: suggestionId,
    agentId,
    status: 'accepted',
    origin: 'synthetic',
    proposedAction: 'Inspect synthetic state',
    expiresAt: new Date(now.getTime() + 60_000),
    snoozedUntil: null,
    acceptedTaskId: activeTaskId,
  });
  const hydration = await chat.getHydrationState(agentId, {
    approvalIds: [approvalId],
    approvalTaskIds: [activeTaskId],
    budgetTaskIds: [activeTaskId],
    suggestionIds: [suggestionId],
  });
  assert.equal(hydration.approvals[0]?.id, approvalId);
  assert.equal(hydration.taskApprovals[0]?.taskId, activeTaskId);
  assert.equal(hydration.budgetTasks[0]?.id, activeTaskId);
  assert.equal(hydration.suggestions[0]?.acceptedTaskStatus, 'running');
  assert.deepEqual(
    await chat.getHydrationState(foreignAgentId, {
      approvalIds: [approvalId],
      approvalTaskIds: [activeTaskId],
      budgetTaskIds: [activeTaskId],
      suggestionIds: [suggestionId],
    }),
    { approvals: [], taskApprovals: [], budgetTasks: [], suggestions: [] },
  );

  const cards = new FirestoreGeneratedCardRepository(store);
  const cardId = randomUUID();
  const firstRevisionId = randomUUID();
  const created = await cards.createOrRevise({
    agentId,
    conversationId: first.id,
    id: cardId,
    revisionId: firstRevisionId,
    sourceFingerprint: `synthetic:${cardId}`,
    sourceLabel: 'Synthetic source',
    spec: { version: 1, title: 'First' },
    expiresAt: null,
  });
  assert.equal(created.revision.version, 1);
  const revised = await cards.createOrRevise({
    agentId,
    targetCardId: cardId,
    conversationId: first.id,
    id: randomUUID(),
    revisionId: randomUUID(),
    sourceFingerprint: `synthetic:${cardId}`,
    sourceLabel: 'Synthetic source',
    spec: { version: 1, title: 'Revised' },
    expiresAt: null,
  });
  assert.equal(revised.revision.version, 2);
  assert.equal((await cards.get(agentId, cardId))?.revision.id, revised.revision.id);
  assert.deepEqual(
    (await cards.list(agentId)).map((entry) => entry.card.id),
    [cardId],
  );
  const refreshTaskId = randomUUID();
  await store.doc('tasks', refreshTaskId).set({
    id: refreshTaskId,
    agentId,
    status: 'pending',
    type: 'card_refresh',
    trigger: { payload: { refreshCardId: cardId } },
    createdAt: now,
  });
  assert.deepEqual(
    (await cards.listRefreshes(agentId, [cardId])).map((task) => task.id),
    [refreshTaskId],
  );
  const refreshes = createFirestoreCardRefreshRepository(store);
  const formatInstruction = () => ({
    title: 'Refresh synthetic card',
    instruction: 'Read the synthetic source using read-only tools.',
  });
  const existingRefresh = await refreshes.request({
    agentId,
    cardId,
    conversationId: first.id,
    formatInstruction,
  });
  assert.equal(existingRefresh.ok && existingRefresh.taskId, refreshTaskId);
  assert.equal(existingRefresh.ok && existingRefresh.created, false);
  await store.doc('tasks', refreshTaskId).update({ status: 'done', updatedAt: new Date() });
  const newRefresh = await refreshes.request({
    agentId,
    cardId,
    conversationId: first.id,
    formatInstruction,
  });
  assert.equal(newRefresh.ok, true);
  assert.equal(newRefresh.ok && newRefresh.created, true);
  if (!newRefresh.ok) throw new Error('Synthetic refresh task was not created');
  const refreshTask = await store.doc('tasks', newRefresh.taskId).get();
  assert.equal(refreshTask.get('trigger.payload.refreshCardId'), cardId);
  const wake = await store
    .collection('outbox')
    .where('taskId', '==', newRefresh.taskId)
    .limit(1)
    .get();
  assert.equal(wake.size, 1);
  assert.equal(await cards.dismiss(foreignAgentId, cardId), false);
  assert.equal(await cards.dismiss(agentId, cardId), true);
  assert.equal(await cards.get(agentId, cardId), null);
  return { profileMemoryCommands: 'passed' as const };
}
