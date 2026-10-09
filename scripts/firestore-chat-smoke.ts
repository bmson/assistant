import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask, type ModelRouter } from '@assistant/core';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  embeddingSpaceKey,
  FirestoreMemoryRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  finalChannelDelivery,
  finalChannelDeliveryReport,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';

export const CHAT_SMOKE_SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'chat-fixture',
  dimensions: 1536,
  revision: '1',
};

/** Full queued chat -> planner -> model -> durable final, with synthetic provider output. */
export async function firestoreChatSmoke(
  store: InstallationStore,
  options: { recall?: boolean } = {},
) {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const skillId = randomUUID();
  const persistence = createFirestoreExecutionPersistence(store, agentId, CHAT_SMOKE_SPACE);
  const now = new Date();
  const request = 'Explain how a rainbow forms.';
  const answer =
    'A rainbow appears when sunlight is refracted and reflected inside water droplets.';
  const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic assistant',
    email: 'assistant@example.invalid',
    signature: '',
    timezone: 'UTC',
    locale: 'en',
    workspacePrefix: 'synthetic',
    credentialRefs: {},
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    channel: 'chat',
    trust: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('ownerCards', agentId).set({
    agentId,
    content: 'Synthetic owner prefers clear explanations.',
    compiledAt: now,
  });
  await store.doc('locationPings', `${agentId}-location`).set({
    id: `${agentId}-location`,
    agentId,
    lat: '37.7',
    lng: '-122.4',
    label: 'Synthetic Observatory',
    accuracyM: 10,
    source: 'test',
    timeZone: 'UTC',
    capturedAt: now,
    createdAt: now,
  });
  assert.equal(
    (
      await persistence.ownerContext.getLatestLocation({
        agentId,
        notBefore: new Date(now.getTime() - 60_000),
        notAfter: now,
        source: 'test',
      })
    )?.id,
    `${agentId}-location`,
  );
  await store.doc('commitments', `${agentId}-commitment`).set({
    id: `${agentId}-commitment`,
    agentId,
    conversationId,
    sourceMessageId: null,
    sourceTaskId: null,
    sourceOccurrenceKey: null,
    reopenedFromId: null,
    reopenOperationId: null,
    kind: 'follow_up',
    title: 'Rainbow observation notes',
    details: '',
    nextAction: 'Compare the rainbow notes',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.9',
    contentHash: 'synthetic-source-free-commitment',
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('skills', skillId).set({
    id: skillId,
    agentId,
    name: 'Explain science clearly',
    preconditions: 'Conceptual science questions',
    steps: 'Start with the physical process.',
    gotchas: 'Avoid unsupported claims.',
    embedding: FieldValue.vector(embedding),
    embeddingSpace: embeddingSpaceKey(CHAT_SMOKE_SPACE),
    deprecated: false,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    ownerAuthored: true,
    originTrust: 'owner',
    sourceTaskId: null,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  if (options.recall) {
    const historyConversationId = randomUUID();
    const historyMessageId = randomUUID();
    const historyAt = new Date(now.getTime() - 86_400_000);
    await store.doc('conversations', historyConversationId).set({
      id: historyConversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      createdAt: historyAt,
      updatedAt: historyAt,
    });
    await store.doc('messages', historyMessageId).set({
      id: historyMessageId,
      conversationId: historyConversationId,
      role: 'user',
      text: 'Historical rainbow observation at the coast',
      createdAt: historyAt,
      embedding: FieldValue.vector(embedding),
      embeddingSpace: embeddingSpaceKey(CHAT_SMOKE_SPACE),
    });
    const segmentId = randomUUID();
    await store.doc('conversationSegments', segmentId).set({
      id: segmentId,
      agentId,
      conversationId: historyConversationId,
      startMessageId: historyMessageId,
      endMessageId: historyMessageId,
      summary: 'Earlier rainbow discussion by the sea',
      startedAt: historyAt,
      endedAt: historyAt,
      createdAt: historyAt,
      updatedAt: historyAt,
      embedding: FieldValue.vector(embedding),
      embeddingSpace: embeddingSpaceKey(CHAT_SMOKE_SPACE),
    });
    const memoryId = randomUUID(),
      subjectId = randomUUID(),
      objectId = randomUUID(),
      relationId = randomUUID();
    await new FirestoreMemoryRepository(store, CHAT_SMOKE_SPACE).save({
      id: memoryId,
      agentId,
      content: 'The owner observes rainbows by the sea.',
      contentHash: `synthetic-${memoryId}`,
      createdAt: historyAt,
      expiresAt: null,
      embedding,
      embeddingSpaceKey: embeddingSpaceKey(CHAT_SMOKE_SPACE),
      sourceTaskId: null,
      kind: 'fact',
      confidence: '1',
      goalId: null,
      originTrust: 'owner',
      category: 'knowledge',
      importance: 3,
      quarantined: false,
      subjectContactId: null,
      domain: null,
      validFrom: null,
      validUntil: null,
      supersededById: null,
      ownerConfirmed: true,
      pinned: false,
      source: 'synthetic',
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    });
    await store
      .doc('knowledgeGraphEntities', subjectId)
      .set({ id: subjectId, agentId, label: 'Owner', preferredLabel: null });
    await store
      .doc('knowledgeGraphEntities', objectId)
      .set({ id: objectId, agentId, label: 'Coastal rainbows', preferredLabel: null });
    await store.doc('knowledgeGraphSources', memoryId).set({
      memoryId,
      status: 'ready',
      contentHash: `synthetic-${memoryId}`,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    await store.doc('knowledgeGraphRelations', relationId).set({
      id: relationId,
      agentId,
      subjectEntityId: subjectId,
      objectEntityId: objectId,
      sourceMemoryId: memoryId,
      predicate: 'observes',
      evidenceQuote: 'The owner observes rainbows by the sea.',
      confidence: '1',
      reviewStatus: 'pending',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      validFrom: null,
      validUntil: null,
    });
    const anchors = await persistence.history.messages({
      agentId,
      embedding,
      embeddingSpaceKey: embeddingSpaceKey(CHAT_SMOKE_SPACE),
      exclude: { conversationId, sinceCreatedAt: now },
      limit: 4,
    });
    assert.equal(anchors[0]?.id, historyMessageId);
    const anchor = anchors[0];
    assert.ok(anchor);
    assert.equal(
      (
        await persistence.history.neighborhood({
          agentId,
          anchor,
          radius: 1,
          exclude: { conversationId, sinceCreatedAt: now },
        })
      ).length,
      1,
    );
  }
  const { task } = await persistence.tasks.createTask({
    agentId,
    conversationId,
    type: 'chat_turn',
    trust: 'owner',
    trigger: { source: 'chat', payload: { text: request } },
  });
  const sqlAccesses: string[] = [];
  const unavailableDb = new Proxy(
    {},
    {
      get: (_target, property) => {
        sqlAccesses.push(String(property));
        throw new Error(`Unexpected SQL access: ${String(property)}`);
      },
    },
  );
  const roles: string[] = [];
  let systemPrompt = '';
  let modelMessages = '';
  let delivered = 0;
  const router = {
    async embeddingSpace() {
      return CHAT_SMOKE_SPACE;
    },
    async embeddingSpaceKey() {
      return embeddingSpaceIdentityKey(CHAT_SMOKE_SPACE);
    },
    async object(role: string) {
      roles.push(role);
      const object =
        role === 'classify'
          ? { trivial: false }
          : role === 'plan'
            ? {
                action: 'reply',
                reasoning: 'Explain the natural phenomenon',
                steps: [],
                missingInfo: [],
              }
            : { decision: 'publish', reasons: [] };
      return { ok: true, object, modelId: 'synthetic/model', degraded: false };
    },
    async embed() {
      return [embedding];
    },
    async step(_role: string, input: { system: string; messages: unknown[] }) {
      systemPrompt = input.system;
      modelMessages = JSON.stringify(input.messages);
      return {
        ok: true,
        modelId: 'synthetic/model',
        degraded: false,
        text: answer,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
  const deps: ExecutorDeps = {
    db: unavailableDb as Db,
    router,
    persistence,
    dispatcher: {
      toolDefs: () => [],
      resultIsUntrusted: () => false,
      dispatch: async () => {
        throw new Error('Unexpected tool dispatch');
      },
      executeApproved: async () => {
        throw new Error('Unexpected approval');
      },
    },
    deliverFinal: async (_task, _text, attemptId) => {
      delivered++;
      return finalChannelDeliveryReport([finalChannelDelivery('dashboard', 'accepted', attemptId)]);
    },
  };
  const outcome = await executeTask(deps, task.id);
  assert.deepEqual(sqlAccesses, [], 'Even best-effort context must avoid SQL');
  assert.equal(outcome.outcome, 'done', JSON.stringify(outcome));
  assert.equal(delivered, 1);
  assert.deepEqual(roles.slice(0, 2), ['classify', 'plan']);
  assert.match(systemPrompt, /Synthetic owner prefers clear explanations/);
  assert.match(systemPrompt, /Synthetic Observatory/);
  assert.match(systemPrompt, /Rainbow observation notes/);
  assert.match(systemPrompt, /Explain science clearly/);
  if (options.recall) {
    // Pre-planning retrieval is carried into the model's message window as
    // reference evidence; it is not duplicated in the static system prompt.
    assert.match(modelMessages, /Earlier rainbow discussion by the sea/);
    assert.match(modelMessages, /Coastal rainbows/);
    const metrics = await store.collection('recallMetrics').where('taskId', '==', task.id).get();
    assert.equal(metrics.size, 1);
    assert.equal(metrics.docs[0]?.get('graphUsed'), 1);
    // Segment and raw-message tiers both contributed one complete source.
    assert.equal(metrics.docs[0]?.get('historyUsed'), 2);
  }
  assert.equal((await store.doc('tasks', task.id).get()).get('plan.action'), 'reply');
  assert.equal((await store.doc('skills', skillId).get()).get('useCount'), 1);
  assert.equal((await store.doc('skills', skillId).get()).get('successCount'), 1);
  assert.equal(
    await persistence.executionEvidence.finalMessageExists({
      agentId,
      conversationId,
      taskId: task.id,
      text: answer,
    }),
    true,
  );
  assert.equal((await executeTask(deps, task.id)).outcome, 'not_claimable');
  assert.equal(delivered, 1);
  return {
    planned: true,
    ownerContext: true,
    skills: true,
    finalized: true,
    sqlAccesses: sqlAccesses.length,
    ...(options.recall ? { history: true, graph: true } : {}),
  };
}
