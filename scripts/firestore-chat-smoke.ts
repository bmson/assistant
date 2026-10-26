import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask, type ModelRouter } from '@assistant/core';
import { fuseOwnerContext } from '@assistant/core/memory/fused-owner-context';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  isExplicitCommitmentReadRequest,
  isSelfContainedTextTransformation,
  latestOwnerIntent,
  resolveActiveReadIntent,
  resolveRecallMode,
} from '@assistant/core/workflow/owner-intent';
import { detectPersonalReadRequest } from '@assistant/core/workflow/read-intent';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  embeddingSpaceKey,
  FirestoreMemoryRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  approvalPolicyFingerprint,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  finalChannelDelivery,
  finalChannelDeliveryReport,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import {
  recallSourceRevision,
  recallSurfaceKey,
} from '../packages/core/src/memory/recall-surfacing.js';

export const CHAT_SMOKE_SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'chat-fixture',
  dimensions: 1536,
  revision: '1',
};

const SMOKE_HISTORY_TEXT = 'The owner observed coastal rainbows by the sea.';
const SMOKE_HISTORY_SUMMARY = 'Earlier coastal rainbows by the sea';
const SMOKE_GRAPH_EVIDENCE = 'The owner observes rainbows by the sea.';
const SMOKE_COMMITMENT_TITLE = 'Rainbow observation notes';
const SMOKE_COMMITMENT_NEXT_ACTION = 'Compare the rainbow notes';
const SMOKE_RAW_HISTORY_SIMILARITY = 0.85;
const SMOKE_POSITIVE_REQUEST =
  'Please help me prepare my observation notes about coastal rainbows by the sea.';

type SmokeExtractSource = { key: string; body: string; speaker: string };

const smokeExtractStopWords = new Set([
  'a',
  'about',
  'an',
  'and',
  'by',
  'can',
  'could',
  'did',
  'do',
  'for',
  'help',
  'i',
  'me',
  'my',
  'of',
  'please',
  'prepare',
  'the',
  'tell',
  'to',
  'what',
  'you',
]);

function smokeExtractTerm(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/ies$/u, 'y')
    .replace(/(?:ed|ing)$/u, '')
    .replace(/s$/u, '');
}

/** Deterministic smoke selector: choose only relevant exact sentences supplied by the caller. */
export function selectSmokeExtractQuotes(prompt: unknown): {
  selections: Array<{ sourceKey: string; quote: string }>;
} | null {
  if (typeof prompt !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const request = (parsed as { request?: unknown }).request;
  const sources = (parsed as { sources?: unknown }).sources;
  if (typeof request !== 'string' || !Array.isArray(sources)) return null;

  const requestTerms = new Set(
    (request.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(smokeExtractTerm)
      .filter((term) => term.length > 1 && !smokeExtractStopWords.has(term)),
  );
  const ownerHistoryRequest = /\bwhat\s+did\s+i\s+(?:tell|say)\s+you\b/iu.test(request);
  const commitmentRequest =
    /\b(?:open\s+)?commitments?\b|\bfollow[- ]?ups?\b|\baction items?\b/iu.test(request);
  const minimumMatches = Math.min(2, requestTerms.size);
  if (minimumMatches === 0) return { selections: [] };

  const selections: Array<{ sourceKey: string; quote: string }> = [];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = raw as SmokeExtractSource;
    if (
      typeof source.key !== 'string' ||
      typeof source.body !== 'string' ||
      typeof source.speaker !== 'string' ||
      !['Recorded owner message', 'Saved fact marked owner-confirmed'].includes(source.speaker)
    )
      continue;
    if (ownerHistoryRequest && source.speaker !== 'Recorded owner message') continue;

    const sentences = source.body
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0 && sentence.length <= 800);
    const candidates = sentences
      .map((quote) => {
        const bodyTerms = new Set((quote.match(/[\p{L}\p{N}]+/gu) ?? []).map(smokeExtractTerm));
        const matchingTerms = [...requestTerms].filter((term) => bodyTerms.has(term));
        const hasCommitmentEvidence =
          /\bcommitments?\b|\bfollow[- ]?ups?\b|\baction items?\b/iu.test(quote);
        return { quote, matchingTerms, hasCommitmentEvidence };
      })
      .filter(
        (candidate) =>
          candidate.matchingTerms.length >= minimumMatches &&
          (!commitmentRequest || candidate.hasCommitmentEvidence),
      )
      .sort((left, right) => right.matchingTerms.length - left.matchingTerms.length);
    const best = candidates[0];
    if (best && source.body.includes(best.quote))
      selections.push({ sourceKey: source.key, quote: best.quote });
  }
  return { selections: selections.slice(0, 8) };
}

function preflightRecallCandidates(
  messageId: string,
  graphRelationId: string,
  graphMemoryId: string,
) {
  const graphMeaning = `Owner observes Coastal rainbows ${SMOKE_GRAPH_EVIDENCE}`;
  return [
    {
      text: `[2026-10-24] Summary excerpt: ${SMOKE_HISTORY_SUMMARY}\n  User: ${SMOKE_HISTORY_TEXT}`,
      meaning: `${SMOKE_HISTORY_SUMMARY} ${SMOKE_HISTORY_TEXT}`,
      score: 1,
      source: {
        date: '2026-10-24',
        label: SMOKE_HISTORY_SUMMARY,
        surfaceKey: recallSurfaceKey('chat:summary_with_excerpt', [messageId]),
        sourceRevision: recallSourceRevision({
          summary: SMOKE_HISTORY_SUMMARY,
          keyMessage: { id: messageId, text: SMOKE_HISTORY_TEXT },
        }),
        relevance: 1,
        evidence: {
          representation: 'summary_with_excerpt' as const,
          sourceMessageIds: [messageId],
          renderedUtf8Bytes: 120,
        },
      },
    },
    {
      text: `[2026-10-24]\n  User: ${SMOKE_HISTORY_TEXT}`,
      meaning: SMOKE_HISTORY_TEXT,
      score: SMOKE_RAW_HISTORY_SIMILARITY,
      source: {
        date: '2026-10-24',
        label: SMOKE_HISTORY_TEXT,
        surfaceKey: recallSurfaceKey('chat:message_excerpts', [messageId]),
        sourceRevision: recallSourceRevision([[messageId, SMOKE_HISTORY_TEXT]]),
        relevance: SMOKE_RAW_HISTORY_SIMILARITY,
        evidence: {
          representation: 'message_excerpts' as const,
          sourceMessageIds: [messageId],
          renderedUtf8Bytes: 70,
        },
      },
    },
    {
      text: `[1 hop] ${graphMeaning}\n  Evidence: ${SMOKE_GRAPH_EVIDENCE}.`,
      meaning: graphMeaning,
      score: 1,
      source: {
        date: '2026-10-24',
        label: graphMeaning.slice(0, 80),
        kind: 'knowledge_graph' as const,
        hops: 1 as const,
        surfaceKey: recallSurfaceKey('knowledge_graph', [graphRelationId]),
        sourceRevision: recallSourceRevision([
          {
            relationId: graphRelationId,
            sourceMemoryId: graphMemoryId,
            assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
            validFrom: null,
            validUntil: null,
            content: null,
            evidenceQuote: SMOKE_GRAPH_EVIDENCE,
          },
        ]),
        relevance: 1,
      },
    },
  ];
}

export async function preflightPlanningRecall(request: string, now: Date) {
  const resolveMode = (text: string) => {
    const trigger = { source: 'chat', payload: { text } };
    const ownerIntent = latestOwnerIntent([{ role: 'user', content: text }], {
      trust: 'owner',
      trigger,
    });
    const ownerText = ownerIntent.ownerAuthoredText;
    const readIntent = resolveActiveReadIntent({ text: ownerText, now, timeZone: 'UTC' });
    const privateRead = detectPersonalReadRequest([{ role: 'user', content: ownerText }]) !== null;
    const localTransformation =
      ownerIntent.authorizedScopes.length === 0 &&
      isSelfContainedTextTransformation(ownerText, ownerIntent.externalText);
    return resolveRecallMode({
      resolvedReadIntent: readIntent,
      ownerIntent,
      enabled: loadConfig().CHAT_RECALL_ENABLED,
      untrustedContext: false,
      trustedTask: true,
      taskType: 'chat_turn',
      conversationId: 'firestore-chat-smoke-preflight',
      localOnly: localTransformation,
      explicitReadRequested: privateRead || isExplicitCommitmentReadRequest(ownerIntent),
      requireNewRequest: true,
    });
  };
  const mode = resolveMode(request);
  const messageId = 'firestore-smoke-history-message-a';
  const graphRelationId = 'firestore-smoke-graph-relation-a';
  const fuse = (
    queryText: string,
    recallMode: 'automatic' | 'disabled',
    rankedContext: ReturnType<typeof preflightRecallCandidates>,
  ) =>
    fuseOwnerContext({
      queryText,
      eligibilityText: queryText,
      mode: recallMode,
      rankedContext,
      limit: 8,
    });
  const permutations = [
    {
      messageId: randomUUID(),
      relationId: randomUUID(),
      memoryId: randomUUID(),
      order: [0, 1, 2],
    },
    {
      messageId: randomUUID(),
      relationId: randomUUID(),
      memoryId: randomUUID(),
      order: [2, 0, 1],
    },
    {
      messageId: randomUUID(),
      relationId: randomUUID(),
      memoryId: randomUUID(),
      order: [1, 2, 0],
    },
  ];
  const positiveMode = resolveMode(SMOKE_POSITIVE_REQUEST);
  const permutedFusions = await Promise.all(
    permutations.map(async ({ messageId, relationId, memoryId, order }) => {
      const candidates = preflightRecallCandidates(messageId, relationId, memoryId);
      const result = await fuse(
        SMOKE_POSITIVE_REQUEST,
        positiveMode === 'automatic' ? 'automatic' : 'disabled',
        order.flatMap((index) => (candidates[index] ? [candidates[index]] : [])),
      );
      return {
        result,
        sourceKinds: result.sources
          .map((source) => source.kind ?? source.evidence?.representation ?? 'unknown')
          .sort(),
      };
    }),
  );
  const firstFusion = permutedFusions.at(0);
  if (!firstFusion) throw new Error('Missing deterministic recall preflight permutation');
  const fused = await fuse(
    request,
    mode === 'automatic' ? 'automatic' : 'disabled',
    preflightRecallCandidates(messageId, graphRelationId, 'firestore-smoke-graph-memory-a'),
  );
  assert.deepEqual(
    permutedFusions.map((entry) => entry.sourceKinds),
    permutedFusions.map(() => ['knowledge_graph', 'summary_with_excerpt']),
    'Fuser selection must preserve history and graph identities across ID and ordering permutations',
  );
  const genericCandidates = preflightRecallCandidates(
    'firestore-smoke-generic-history',
    'firestore-smoke-generic-relation',
    'firestore-smoke-generic-memory',
  );
  const generic = await fuse(
    'Explain how a rainbow forms.',
    resolveMode('Explain how a rainbow forms.') === 'automatic' ? 'automatic' : 'disabled',
    genericCandidates,
  );
  return {
    mode,
    sources: fused.sources,
    genericMode: resolveMode('Explain how a rainbow forms.'),
    genericSources: generic.sources,
    expectedSourceKeys: [
      recallSurfaceKey('chat:summary_with_excerpt', [messageId]),
      recallSurfaceKey('knowledge_graph', [graphRelationId]),
    ].sort(),
  };
}

/** Full queued chat -> planner -> model -> durable final, with synthetic provider output. */
export async function firestoreChatSmoke(
  store: InstallationStore,
  options: {
    recall?: boolean;
    request?: string;
    expectRecall?: boolean;
    expectRecallMode?: 'automatic' | 'explicit' | 'disabled';
    expectOpenCommitment?: boolean;
    expectedOutcome?: 'done' | 'needs_attention';
    expectedMemoryReadFailure?: 'incomplete_selection';
    expectedDeliveredTextIncludes?: string[];
    expectedDeliveredTextExcludes?: string[];
  } = {},
) {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const skillId = randomUUID();
  const persistence = createFirestoreExecutionPersistence(store, agentId, CHAT_SMOKE_SPACE);
  const now = new Date();
  let expectedRuntimeSourceKeys: string[] = [];
  let syntheticHistoryMessageId: string | undefined;
  let syntheticHistoryConversationId: string | undefined;
  const request = options.request ?? 'Explain how a rainbow forms.';
  const expectedRecallMode = options.expectRecallMode ?? 'automatic';
  const recallPreflight = options.recall ? await preflightPlanningRecall(request, now) : undefined;
  if (options.recall) {
    assert.equal(
      recallPreflight?.mode,
      expectedRecallMode,
      'The recall fixture request must resolve through its expected read path',
    );
    assert.equal(recallPreflight?.genericMode, 'automatic');
    assert.deepEqual(recallPreflight?.genericSources, []);
    assert.deepEqual(
      recallPreflight?.sources.map((source) => source.surfaceKey).sort(),
      expectedRecallMode === 'automatic' && options.expectRecall === true
        ? recallPreflight?.expectedSourceKeys
        : [],
      'The same synthetic source universe must fuse only subject-eligible source identities',
    );
  }
  const answer =
    'A rainbow appears when sunlight is refracted and reflected inside water droplets.';
  const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const historyMessageEmbedding = Array.from({ length: 1536 }, (_, index) =>
    index === 0
      ? SMOKE_RAW_HISTORY_SIMILARITY
      : index === 1
        ? Math.sqrt(1 - SMOKE_RAW_HISTORY_SIMILARITY ** 2)
        : 0,
  );
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
    title: SMOKE_COMMITMENT_TITLE,
    details: '',
    nextAction: SMOKE_COMMITMENT_NEXT_ACTION,
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
    syntheticHistoryMessageId = historyMessageId;
    syntheticHistoryConversationId = historyConversationId;
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
      origin: 'owner',
      text: SMOKE_HISTORY_TEXT,
      createdAt: historyAt,
      // Keep the raw-message candidate above the history recall threshold but
      // below the exact summary/graph matches so the two-source fuser cap is
      // stable regardless of randomized source IDs.
      embedding: FieldValue.vector(historyMessageEmbedding),
      embeddingSpace: embeddingSpaceKey(CHAT_SMOKE_SPACE),
    });
    const segmentId = randomUUID();
    await store.doc('conversationSegments', segmentId).set({
      id: segmentId,
      agentId,
      conversationId: historyConversationId,
      startMessageId: historyMessageId,
      endMessageId: historyMessageId,
      summary: SMOKE_HISTORY_SUMMARY,
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
    expectedRuntimeSourceKeys = [
      recallSurfaceKey('chat:summary_with_excerpt', [historyMessageId]),
      recallSurfaceKey('knowledge_graph', [relationId]),
    ].sort();
    await new FirestoreMemoryRepository(store, CHAT_SMOKE_SPACE).save({
      id: memoryId,
      agentId,
      content: SMOKE_GRAPH_EVIDENCE,
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
      evidenceQuote: SMOKE_GRAPH_EVIDENCE,
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
  let modelSteps = 0;
  const dispatchReceipts: Array<{
    toolCallId: string;
    taskId: string;
    step: number;
    toolName: string;
    modelToolCallId: string;
    args: Record<string, unknown>;
    result: unknown;
  }> = [];
  let systemPrompt = '';
  let modelMessages = '';
  const extractPrompts: unknown[] = [];
  const extractSelections: unknown[] = [];
  let delivered = 0;
  let deliveredText = '';
  const router = {
    async embeddingSpace() {
      return CHAT_SMOKE_SPACE;
    },
    async embeddingSpaceKey() {
      return embeddingSpaceIdentityKey(CHAT_SMOKE_SPACE);
    },
    async object(role: string, options: { prompt?: unknown }) {
      roles.push(role);
      const extractSelection = role === 'extract' ? selectSmokeExtractQuotes(options.prompt) : null;
      if (role === 'extract') {
        extractPrompts.push(options.prompt);
        extractSelections.push(extractSelection);
      }
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
            : role === 'extract'
              ? extractSelection
              : { decision: 'publish', reasons: [] };
      return { ok: true, object, modelId: 'synthetic/model', degraded: false };
    },
    async embed() {
      return [embedding];
    },
    async step(_role: string, input: { system: string; messages: unknown[] }) {
      modelSteps += 1;
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
  const persistSyntheticRead = async (
    input: Parameters<ExecutorDeps['dispatcher']['dispatch']>[0],
    result: unknown,
  ) => {
    const toolCall = await persistence.toolExecution.start({
      agentId: input.task.agentId,
      taskId: input.task.id,
      step: input.step,
      toolName: input.toolName,
      args: input.args,
      idempotencyKey: null,
      decision: { modelToolCallId: input.modelToolCallId },
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
    });
    if (!toolCall) return { kind: 'rejected' as const, reason: 'tool call was not persisted' };
    const persisted = await persistence.toolExecution.outcome({
      agentId: input.task.agentId,
      taskId: input.task.id,
      toolCallId: toolCall.id,
      status: 'succeeded',
      fromStatus: 'executing',
      result,
    });
    if (!persisted) return { kind: 'rejected' as const, reason: 'tool success was not persisted' };
    dispatchReceipts.push({
      toolCallId: toolCall.id,
      taskId: input.task.id,
      step: input.step,
      toolName: input.toolName,
      modelToolCallId: input.modelToolCallId,
      args: input.args,
      result,
    });
    return { kind: 'executed' as const, toolCallId: toolCall.id, result, cached: false };
  };
  const deps: ExecutorDeps = {
    db: unavailableDb as Db,
    router,
    persistence,
    dispatcher: {
      toolDefs: () =>
        ['calendar.list_events', 'gmail.search', 'conversations.search'].map((name) => ({
          name,
          description: 'Synthetic private-read fixture tool.',
          inputSchema: {} as never,
        })),
      resultIsUntrusted: (toolName) => toolName === 'conversations.search',
      dispatch: async (input) => {
        if (input.toolName === 'calendar.list_events') {
          return persistSyntheticRead(input, { events: [], complete: true });
        }
        if (input.toolName === 'gmail.search') {
          return persistSyntheticRead(input, { results: [], complete: true, hasMore: false });
        }
        if (input.toolName === 'conversations.search') {
          const messageId = syntheticHistoryMessageId ?? 'synthetic-history-message';
          const historyConversationId =
            syntheticHistoryConversationId ?? 'synthetic-history-conversation';
          return persistSyntheticRead(input, {
            matches: [
              {
                messageId,
                conversationId: historyConversationId,
                text: SMOKE_HISTORY_TEXT,
                role: 'user',
                origin: 'owner',
                sourceRevision: conversationMessageSourceRevision(messageId, SMOKE_HISTORY_TEXT),
                speakerRevision: conversationMessageSpeakerRevision(
                  messageId,
                  SMOKE_HISTORY_TEXT,
                  'user',
                  'owner',
                ),
              },
            ],
            mode: 'semantic',
          });
        }
        throw new Error(`Unexpected tool dispatch: ${input.toolName}`);
      },
      executeApproved: async () => {
        throw new Error('Unexpected approval');
      },
    },
    deliverFinal: async (_task, text, attemptId) => {
      delivered++;
      deliveredText = text;
      return finalChannelDeliveryReport([finalChannelDelivery('dashboard', 'accepted', attemptId)]);
    },
  };
  const outcome = await executeTask(deps, task.id);
  const negativeReadDiagnostics = options.expectedMemoryReadFailure
    ? (() => {
        const extractPasses = extractPrompts.map((prompt, index) => {
          let sources: Array<{ key?: unknown; speaker?: unknown }> = [];
          if (typeof prompt === 'string') {
            try {
              const parsed = JSON.parse(prompt) as { sources?: unknown };
              if (Array.isArray(parsed.sources))
                sources = parsed.sources.filter(
                  (source): source is { key?: unknown; speaker?: unknown } =>
                    Boolean(source) && typeof source === 'object' && !Array.isArray(source),
                );
            } catch {
              // The failure context should remain printable even for a malformed prompt.
            }
          }
          const selection = extractSelections[index] as
            | { selections?: Array<{ sourceKey?: unknown }> }
            | null
            | undefined;
          const selectedKeys = Array.isArray(selection?.selections)
            ? selection.selections
                .map((entry) => entry.sourceKey)
                .filter((key): key is string => typeof key === 'string')
            : [];
          return {
            sourceKeys: sources
              .map((source) => source.key)
              .filter((key): key is string => typeof key === 'string'),
            speakers: sources
              .map((source) => source.speaker)
              .filter((speaker): speaker is string => typeof speaker === 'string'),
            selectedKeys,
            selectorReason:
              selection === null || selection === undefined
                ? 'selector returned no usable selection object'
                : selectedKeys.length === 0
                  ? 'selector returned no exact passage; expected server failureReason incomplete_selection'
                  : 'selector returned one or more exact passage keys',
          };
        });
        return `Synthetic private-read failure diagnostics: ${JSON.stringify({
          taskId: task.id,
          roles,
          readReceipts: dispatchReceipts.map((receipt) => ({
            toolCallId: receipt.toolCallId,
            step: receipt.step,
            toolName: receipt.toolName,
            query: receipt.args.query,
          })),
          deliveredText,
          outcomeDetail: outcome.detail,
          extractPasses,
          expectedFailureReason: options.expectedMemoryReadFailure,
        })}`;
      })()
    : '';
  const failureContext = negativeReadDiagnostics ? `\n${negativeReadDiagnostics}` : '';
  assert.deepEqual(sqlAccesses, [], 'Even best-effort context must avoid SQL');
  if (options.expectedOutcome === 'needs_attention')
    assert.equal(options.expectedMemoryReadFailure, 'incomplete_selection');
  assert.equal(
    outcome.outcome,
    options.expectedOutcome ?? 'done',
    `${JSON.stringify(outcome)}${failureContext}`,
  );
  assert.equal(delivered, 1, failureContext);
  if (options.expectedDeliveredTextIncludes) {
    for (const expected of options.expectedDeliveredTextIncludes)
      assert.ok(
        deliveredText.includes(expected),
        `Expected final delivery to include: ${expected}${failureContext}`,
      );
  }
  if (options.expectedDeliveredTextExcludes) {
    for (const forbidden of options.expectedDeliveredTextExcludes)
      assert.ok(
        !deliveredText.includes(forbidden),
        `Final delivery must not include: ${forbidden}`,
      );
  }
  if (options.expectedMemoryReadFailure) {
    assert.equal(options.expectedOutcome, 'needs_attention');
    assert.equal(outcome.outcome, 'needs_attention');
    assert.ok(
      outcome.detail?.includes(
        'I found candidate owner-authored records, but could not reliably select a directly relevant passage.',
      ),
      `Expected the exact incomplete-selection outcome diagnostic${failureContext}`,
    );
    for (const extractPrompt of extractPrompts) {
      assert.equal(typeof extractPrompt, 'string');
      const parsedExtractPrompt = JSON.parse(extractPrompt as string) as {
        sources?: Array<{ body?: unknown; speaker?: unknown }>;
      };
      assert.ok(Array.isArray(parsedExtractPrompt.sources));
      assert.ok(
        parsedExtractPrompt.sources.some(
          (source) =>
            source.body === SMOKE_HISTORY_TEXT && source.speaker === 'Recorded owner message',
        ),
        'Expected the retrieved owner history source to reach exact passage selection',
      );
      for (const source of parsedExtractPrompt.sources) {
        if (typeof source.body !== 'string') continue;
        assert.ok(!source.body.includes(SMOKE_COMMITMENT_TITLE));
        assert.ok(!source.body.includes(SMOKE_COMMITMENT_NEXT_ACTION));
      }
    }
    assert.doesNotMatch(systemPrompt, /Rainbow observation notes/u);
    assert.doesNotMatch(systemPrompt, /Compare the rainbow notes/u);
    assert.doesNotMatch(modelMessages, /Rainbow observation notes/u);
    assert.doesNotMatch(modelMessages, /Compare the rainbow notes/u);
    assert.doesNotMatch(deliveredText, /Rainbow observation notes/u);
    assert.doesNotMatch(deliveredText, /Compare the rainbow notes/u);
  }
  const explicitRead = detectPersonalReadRequest([{ role: 'user', content: request }]);
  const deterministicPrivateRead = Boolean(explicitRead);
  if (options.expectedMemoryReadFailure) {
    assert.equal(explicitRead?.firstToolName, 'conversations.search');
    assert.ok(extractSelections.length > 0);
    assert.deepEqual(
      extractSelections,
      extractSelections.map(() => ({ selections: [] })),
      'Expected each exact source-selection pass to return no unsupported commitment passage',
    );
  }
  if (!deterministicPrivateRead) {
    assert.deepEqual(roles.slice(0, 2), ['classify', 'plan']);
  }
  const responseModelExecuted = modelSteps > 0;
  // Explicit private reads intentionally skip owner-card and ambient context.
  // The model may still run for bounded read orchestration, but that does not
  // make it a general response turn that should receive these context blocks.
  if (responseModelExecuted && !deterministicPrivateRead) {
    assert.match(systemPrompt, /Synthetic owner prefers clear explanations/);
    assert.match(systemPrompt, /Synthetic Observatory/);
  } else if (responseModelExecuted) {
    assert.doesNotMatch(systemPrompt, /Synthetic owner prefers clear explanations/);
    assert.doesNotMatch(systemPrompt, /Synthetic Observatory/);
  }
  const privateRecallCanaries = [
    /Rainbow observation notes/,
    /Earlier coastal rainbows by the sea/,
    /The owner observes rainbows by the sea\./,
  ];
  if (responseModelExecuted && options.expectOpenCommitment) {
    assert.match(systemPrompt, /Rainbow observation notes/);
    assert.doesNotMatch(systemPrompt, /Earlier coastal rainbows by the sea/);
    assert.doesNotMatch(systemPrompt, /The owner observes rainbows by the sea\./);
  } else if (
    responseModelExecuted &&
    (!options.recall || expectedRecallMode === 'explicit' || options.expectRecall === false)
  ) {
    const canaries =
      expectedRecallMode === 'explicit'
        ? [privateRecallCanaries[0] as RegExp]
        : privateRecallCanaries;
    for (const canary of canaries) {
      assert.doesNotMatch(systemPrompt, canary);
      assert.doesNotMatch(modelMessages, canary);
    }
  } else if (responseModelExecuted) {
    // Relevant history and graph are selected through the shared two-source
    // fuser; the commitment is not independently injected through openLoops.
    const commitmentCanary = /Rainbow observation notes/;
    assert.doesNotMatch(systemPrompt, commitmentCanary);
    assert.doesNotMatch(modelMessages, commitmentCanary);
  }
  if (responseModelExecuted) assert.match(systemPrompt, /Explain science clearly/);
  if (options.recall && expectedRecallMode === 'automatic') {
    // Pre-planning retrieval is carried into the model's message window as
    // reference evidence; it is not duplicated in the static system prompt.
    assert.equal(
      modelMessages.includes('Earlier coastal rainbows by the sea'),
      options.expectRecall === true,
    );
    assert.equal(modelMessages.includes('Coastal rainbows'), options.expectRecall === true);
    const metrics = await store.collection('recallMetrics').where('taskId', '==', task.id).get();
    assert.equal(metrics.size, 1);
    assert.equal(metrics.docs[0]?.get('graphUsed'), 1);
    // Segment and raw-message tiers both produced candidates; eligibility decides
    // whether those candidates enter the model window.
    assert.equal(metrics.docs[0]?.get('historyUsed'), 2);
  }
  const persistedTask = await store.doc('tasks', task.id).get();
  assert.equal(persistedTask.get('plan.action'), deterministicPrivateRead ? 'workflow' : 'reply');
  if (deterministicPrivateRead) {
    const expectedTool = explicitRead?.firstToolName;
    assert.ok(expectedTool, `Expected a supported deterministic read for: ${request}`);
    const matchingReceipts = dispatchReceipts.filter((entry) => entry.toolName === expectedTool);
    if (options.expectedMemoryReadFailure) assert.equal(matchingReceipts.length, 1);
    const receipt = matchingReceipts[0];
    assert.ok(receipt, `Expected successful ${expectedTool} dispatcher receipt`);
    const persistedCalls = await persistence.executionEvidence.taskEvidence({
      agentId,
      taskId: task.id,
    });
    const persistedReceipt = persistedCalls.find((call) => call.id === receipt.toolCallId);
    assert.ok(persistedReceipt, `Expected persisted successful ${expectedTool} receipt`);
    assert.equal(receipt.taskId, task.id);
    assert.equal(persistedReceipt.toolName, receipt.toolName);
    assert.equal(persistedReceipt.step, receipt.step);
    assert.equal(persistedReceipt.status, 'succeeded');
    assert.equal(
      (persistedReceipt.decision as { modelToolCallId?: unknown } | null)?.modelToolCallId,
      receipt.modelToolCallId,
    );
    assert.deepEqual(persistedReceipt.args, receipt.args);
    assert.deepEqual(persistedReceipt.result, receipt.result);
    if (expectedTool === 'conversations.search') {
      assert.equal(typeof receipt.args.query, 'string');
      assert.ok((receipt.args.query as string).length >= 2);
      const result = receipt.result as { matches?: unknown[] };
      assert.ok(Array.isArray(result.matches) && result.matches.length > 0);
      assert.equal(
        (persistedReceipt.args as { query?: unknown } | undefined)?.query,
        explicitRead?.conversationQuery,
      );
      const persistedResult = persistedReceipt.result as { matches?: unknown[] } | undefined;
      const persistedMatches = persistedResult?.matches;
      assert.ok(Array.isArray(persistedMatches) && persistedMatches.length > 0);
      assert.ok(
        (persistedMatches as Array<Record<string, unknown>>).some(
          (match) =>
            match.messageId === syntheticHistoryMessageId &&
            match.conversationId === syntheticHistoryConversationId &&
            match.text === SMOKE_HISTORY_TEXT,
        ),
        'Expected the successful source-read receipt to contain the exact seeded owner message',
      );
    }
  }
  const taskState = persistedTask.get('state') as
    | {
        plannerState?: { planningRecall?: { status?: string; sourceCount?: number } };
        recall?: Array<{ surfaceKey?: string }>;
      }
    | undefined;
  const planningRecall = taskState?.plannerState?.planningRecall;
  const runtimeSourceKeys = (taskState?.recall ?? [])
    .map((source) => source.surfaceKey)
    .filter((key): key is string => Boolean(key))
    .sort();
  if (options.recall && expectedRecallMode === 'automatic') {
    // Only the automatic/continuation planning-recall path writes `complete`;
    // a generic request must complete the gate while surfacing no sources.
    assert.equal(planningRecall?.status, 'complete');
    if (options.expectRecall === true) {
      assert.ok((planningRecall?.sourceCount ?? 0) > 0);
      assert.deepEqual(runtimeSourceKeys, expectedRuntimeSourceKeys);
    } else {
      assert.equal(planningRecall?.sourceCount ?? 0, 0);
      assert.deepEqual(runtimeSourceKeys, []);
      for (const canary of privateRecallCanaries) assert.doesNotMatch(modelMessages, canary);
    }
  }
  const skillApplied = responseModelExecuted && systemPrompt.includes('Explain science clearly');
  assert.equal((await store.doc('skills', skillId).get()).get('useCount'), skillApplied ? 1 : 0);
  assert.equal(
    (await store.doc('skills', skillId).get()).get('successCount'),
    skillApplied ? 1 : 0,
  );
  assert.equal(
    await persistence.executionEvidence.finalMessageExists({
      agentId,
      conversationId,
      taskId: task.id,
      text: deliveredText,
    }),
    true,
  );
  assert.equal((await executeTask(deps, task.id)).outcome, 'not_claimable');
  assert.equal(delivered, 1);
  return {
    planned: true,
    ownerContext: true,
    skills: skillApplied,
    finalized: true,
    sqlAccesses: sqlAccesses.length,
    ...(options.expectedOutcome ? { outcome: outcome.outcome } : {}),
    ...(options.recall
      ? {
          historySurfaced: options.expectRecall === true,
          graphSurfaced: options.expectRecall === true,
          planningRecallStatus: planningRecall?.status,
          planningRecallSourceCount: planningRecall?.sourceCount ?? 0,
          preflightRecallMode: recallPreflight?.mode,
          preflightSourceKeys: recallPreflight?.sources.map((source) => source.surfaceKey).sort(),
          expectedPreflightSourceKeys: recallPreflight?.expectedSourceKeys,
          runtimeSourceKeys,
          dispatchReceipts,
        }
      : {}),
  };
}
