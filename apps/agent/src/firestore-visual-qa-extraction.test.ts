import { randomUUID } from 'node:crypto';
import type { ExecutorDeps } from '@assistant/core';
import { extractCommitments } from '@assistant/core/memory/commitments';
import { runMemoryExtraction } from '@assistant/core/memory/extraction';
import { recallKnowledgeGraph } from '@assistant/core/memory/graph-recall';
import { syncKnowledgeGraph } from '@assistant/core/memory/knowledge-graph';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreGraphRecallRepository,
  FirestoreKnowledgeGraphSyncRepository,
  FirestoreMemoryToolRepository,
} from '@assistant/firestore';
import { type ExecutionPersistence, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = {
  provider: 'synthetic',
  model: 'ops16-fixture-test',
  dimensions: 1536,
  revision: '1',
} as const;
const VECTOR = Array.from({ length: SPACE.dimensions }, (_, index) => (index === 0 ? 1 : 0));
const ORDINARY_TEXT =
  'ORDINARY_SOURCE: OPS16 Owner works at OPS16 Northwind and will read before breakfast.';
const FIXTURE_TEXT = 'VISUAL_QA_SOURCE: The owner works at Fixture Lab.';
const READABILITY_TEXT = 'READABILITY_SOURCE: The owner works at Readability Studio.';
const ORDINARY_FACT = 'OPS16 Owner works at OPS16 Northwind and will read before breakfast.';
const FIXTURE_FACT = 'The owner works at Fixture Lab.';
const READABILITY_FACT = 'The owner works at Readability Studio.';
const ORDINARY_COMMITMENT = 'Read before breakfast';
const FIXTURE_COMMITMENT = 'Move to Iceland next week';
const READABILITY_COMMITMENT = 'Publish a private draft tomorrow';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pauseWorkerForCleanup<T>(
  started: Promise<T>,
  worker: Promise<unknown>,
  release: () => void,
  cleanup: () => Promise<unknown>,
  label: string,
): Promise<T> {
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let value: T | undefined;
  let primaryError: unknown;
  try {
    value = await Promise.race([
      started,
      worker.then(() => {
        throw new Error(`${label} completed without reaching the fake model`);
      }),
      new Promise<T>((_, reject) => {
        startTimer = setTimeout(
          () =>
            reject(new Error(`${label} did not reach the fake model before the barrier deadline`)),
          10_000,
        );
      }),
    ]);
    await cleanup();
  } catch (error) {
    primaryError = error;
  } finally {
    if (startTimer) clearTimeout(startTimer);
    release();
  }

  let workerError: unknown;
  try {
    await Promise.race([
      worker,
      new Promise<never>((_, reject) => {
        waitTimer = setTimeout(
          () => reject(new Error(`${label} did not settle after its barrier was released`)),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    workerError = error;
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
  }

  if (primaryError !== undefined && workerError !== undefined)
    throw new AggregateError(
      [primaryError, workerError],
      `${label} cleanup and worker both failed`,
    );
  if (primaryError !== undefined) throw primaryError;
  if (workerError !== undefined) throw workerError;
  if (value === undefined) throw new Error(`${label} barrier returned no prompt`);
  return value;
}

type SeedMessage = { id: string; text: string; channelMessageId: string | null };

/** Exercises the real Firestore memory-extraction adapter with fake model output. */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'visual QA extraction exclusion (Firestore)',
  () => {
    const agentId = randomUUID();
    const ownerContactId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let db: Db;
    const sqlAccesses: string[] = [];

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      db = new Proxy(
        {},
        {
          get: (_target, property) => {
            sqlAccesses.push(String(property));
            throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
          },
        },
      ) as Db;
      await store.doc('agents', agentId).set({ id: agentId, name: 'OPS16 owner', timezone: 'UTC' });
      await store.doc('contacts', ownerContactId).set(
        encodeRecord({
          id: ownerContactId,
          name: 'OPS16 owner',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'self',
          notes: '',
          trust: 'owner',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function seedConversation(
      title: string,
      rows: Array<{ text: string; channelMessageId?: string | null }>,
    ): Promise<{ conversationId: string; messages: SeedMessage[] }> {
      const conversationId = randomUUID();
      const now = new Date();
      await store.doc('conversations', conversationId).set(
        encodeRecord({
          id: conversationId,
          agentId,
          title,
          channel: 'chat',
          trust: 'owner',
          archivedAt: null,
          modelOverride: null,
          isPrimary: false,
          metadata: {},
          lastReadAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const seeded: SeedMessage[] = [];
      for (const [index, row] of rows.entries()) {
        const id = randomUUID();
        const message = {
          id,
          conversationId,
          taskId: null,
          role: 'user',
          parts: [],
          text: row.text,
          origin: 'chat',
          channelMessageId: row.channelMessageId ?? null,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(now.getTime() + index),
        };
        await store.doc('messages', id).set(encodeRecord(message));
        seeded.push({ id, text: row.text, channelMessageId: row.channelMessageId ?? null });
      }
      return { conversationId, messages: seeded };
    }

    async function lease() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
      });
      const claimed = await persistence.tasks.claim(task.id);
      if (!claimed?.leaseToken) throw new Error('could not claim extraction task');
      return { taskId: task.id, lease: { taskId: task.id, leaseToken: claimed.leaseToken } };
    }

    function fakeRouter(
      onMemoryPrompt?: (prompt: string) => Promise<void>,
      onCommitmentPrompt?: (prompt: string) => Promise<void>,
    ) {
      const prompts: Array<{ pass: 'memory' | 'commitments'; text: string }> = [];
      const router = {
        async embeddingSpace() {
          return SPACE;
        },
        async embeddingSpaceKey() {
          return embeddingSpaceIdentityKey(SPACE);
        },
        async embed(texts: string[]) {
          return texts.map(() => VECTOR);
        },
        async object(_role: string, input: { prompt?: string }) {
          const prompt = input.prompt ?? '';
          const pass = prompt.startsWith('Conversation (source trust:') ? 'memory' : 'commitments';
          prompts.push({ pass, text: prompt });
          if (pass === 'memory') {
            await onMemoryPrompt?.(prompt);
            const facts = [];
            if (prompt.includes(ORDINARY_TEXT))
              facts.push({
                content: ORDINARY_FACT,
                kind: 'preference',
                category: 'knowledge',
                subject: { type: 'owner' },
                relationship: '',
                domain: 'preferences',
                importance: 3,
                confidence: 0.95,
                validFrom: '',
              });
            if (prompt.includes(FIXTURE_TEXT))
              facts.push({
                content: FIXTURE_FACT,
                kind: 'fact',
                category: 'knowledge',
                subject: { type: 'owner' },
                relationship: '',
                domain: 'personal',
                importance: 3,
                confidence: 0.95,
                validFrom: '',
              });
            if (prompt.includes(READABILITY_TEXT))
              facts.push({
                content: READABILITY_FACT,
                kind: 'fact',
                category: 'knowledge',
                subject: { type: 'owner' },
                relationship: '',
                domain: 'personal',
                importance: 3,
                confidence: 0.95,
                validFrom: '',
              });
            return { ok: true, modelId: 'fake', degraded: false, object: { facts, occasions: [] } };
          }

          await onCommitmentPrompt?.(prompt);
          const hasVisualQa = prompt.includes(FIXTURE_TEXT);
          const hasReadability = prompt.includes(READABILITY_TEXT);
          const hasFixture = hasVisualQa || hasReadability;
          const sourceIds = [...prompt.matchAll(/\[message_id=([0-9a-f-]{36})\] owner:/g)]
            .map((match) => match[1])
            .filter((id): id is string => Boolean(id));
          const sourceMessageId = hasFixture ? sourceIds.at(-1) : sourceIds[0];
          return {
            ok: true,
            modelId: 'fake',
            degraded: false,
            object: {
              commitments:
                sourceMessageId && (hasFixture || prompt.includes(ORDINARY_TEXT))
                  ? [
                      {
                        kind: 'promise',
                        title: hasVisualQa
                          ? FIXTURE_COMMITMENT
                          : hasReadability
                            ? READABILITY_COMMITMENT
                            : ORDINARY_COMMITMENT,
                        details: '',
                        nextAction: '',
                        dueAt: '',
                        confidence: 0.95,
                        sourceMessageIds: [sourceMessageId],
                      },
                    ]
                  : [],
              resolvedTitles: [],
            },
          };
        },
      };
      return { router: router as unknown as ExecutorDeps['router'], prompts };
    }

    const since = () => new Date(Date.now() - 60 * 60 * 1000);

    it('does not call the model or persist data from fixture-only owner transcripts', async () => {
      await seedConversation('fixture-only', [
        { text: FIXTURE_TEXT, channelMessageId: `visual-qa:${randomUUID()}:a` },
        {
          text: 'The owner will move to Iceland next week.',
          channelMessageId: `visual-qa:${randomUUID()}:b`,
        },
      ]);
      const { router, prompts } = fakeRouter();
      const task = await lease();

      const memory = await runMemoryExtraction(
        { db, router, persistence },
        { agentId, taskId: task.taskId, lease: () => task.lease, since: since() },
      );
      const loops = await extractCommitments(
        { db, router, persistence },
        { agentId, taskId: task.taskId, lease: () => task.lease, since: since() },
      );

      expect(prompts).toEqual([]);
      expect(memory).toMatchObject({ conversationsScanned: 0, saved: 0 });
      expect(loops).toMatchObject({ conversationsScanned: 0, saved: 0 });
      expect((await store.collection('memories').where('agentId', '==', agentId).get()).size).toBe(
        0,
      );
      expect(
        (await store.collection('commitments').where('agentId', '==', agentId).get()).size,
      ).toBe(0);
      expect(sqlAccesses).toEqual([]);
    });

    it('skips readability-only owner transcripts before extraction or commitment storage', async () => {
      const readability = await seedConversation('readability-only', [
        {
          text: READABILITY_TEXT,
          channelMessageId: `readability-run-${randomUUID()}-01-user`,
        },
      ]);
      const { router, prompts } = fakeRouter();
      const task = await lease();

      const memory = await runMemoryExtraction(
        { db, router, persistence },
        { agentId, taskId: task.taskId, lease: () => task.lease, since: since() },
      );
      const commitmentsRun = await extractCommitments(
        { db, router, persistence },
        { agentId, taskId: task.taskId, lease: () => task.lease, since: since() },
      );

      expect(readability.messages).toHaveLength(1);
      expect(prompts).toEqual([]);
      expect(memory).toMatchObject({ conversationsScanned: 0, saved: 0 });
      expect(commitmentsRun).toMatchObject({ conversationsScanned: 0, saved: 0 });
      expect((await store.collection('memories').where('agentId', '==', agentId).get()).size).toBe(
        0,
      );
      expect(
        (await store.collection('commitments').where('agentId', '==', agentId).get()).size,
      ).toBe(0);
      expect(sqlAccesses).toEqual([]);
    });

    it('keeps ordinary extraction, recall, and source IDs while cleanup races worker snapshots', async () => {
      const mixed = await seedConversation('ordinary-and-fixture', [{ text: ORDINARY_TEXT }]);
      const ordinary = mixed.messages[0];
      if (!ordinary) throw new Error('ordinary source row is missing');
      const memoryFixtureMessage = randomUUID();
      await store.doc('messages', memoryFixtureMessage).set(
        encodeRecord({
          id: memoryFixtureMessage,
          conversationId: mixed.conversationId,
          taskId: null,
          role: 'user',
          parts: [],
          text: FIXTURE_TEXT,
          origin: 'chat',
          channelMessageId: `visual-qa:${randomUUID()}:memory`,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(Date.now() + 1),
        }),
      );
      const readabilityFixtureMessage = randomUUID();
      await store.doc('messages', readabilityFixtureMessage).set(
        encodeRecord({
          id: readabilityFixtureMessage,
          conversationId: mixed.conversationId,
          taskId: null,
          role: 'user',
          parts: [],
          text: READABILITY_TEXT,
          origin: 'chat',
          channelMessageId: `readability-${randomUUID()}-03-user`,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(Date.now() + 2),
        }),
      );
      const memoryStarted = deferred<string>();
      const releaseMemory = deferred();
      let memoryGateUsed = false;
      const memoryFixtureRows = fakeRouter(async (prompt) => {
        if (!memoryGateUsed) {
          memoryGateUsed = true;
          memoryStarted.resolve(prompt);
          await releaseMemory.promise;
        }
      });
      const memoryTask = await lease();
      const memoryRun = runMemoryExtraction(
        { db, router: memoryFixtureRows.router, persistence },
        {
          agentId,
          taskId: memoryTask.taskId,
          lease: () => memoryTask.lease,
          since: since(),
        },
      );
      const memoryPrompt = await pauseWorkerForCleanup(
        memoryStarted.promise,
        memoryRun,
        () => releaseMemory.resolve(),
        () => store.doc('messages', memoryFixtureMessage).delete(),
        'Memory extraction',
      );

      const extracted = await memoryRun;

      expect(memoryFixtureRows.prompts.filter((row) => row.pass === 'memory')).toHaveLength(1);
      expect(memoryPrompt).toContain(ORDINARY_TEXT);
      expect(memoryPrompt).not.toContain(FIXTURE_TEXT);
      expect(memoryPrompt).not.toContain(READABILITY_TEXT);
      expect(extracted.saved).toBe(1);
      const rows = await store.collection('memories').where('agentId', '==', agentId).get();
      expect(rows.docs.map((doc) => doc.get('content'))).toEqual([ORDINARY_FACT]);
      expect(rows.docs[0]?.data()).toMatchObject({
        source: 'extraction',
        originTrust: 'owner',
        quarantined: false,
      });
      const recalled = await new FirestoreMemoryToolRepository(store, SPACE).recall({
        agentId,
        embedding: VECTOR,
        embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
        query: 'OPS16 Northwind',
        limit: 5,
      });
      expect(recalled.memories.map((row) => row.content)).toContain(ORDINARY_FACT);
      expect(
        recalled.memories.some((row) => [FIXTURE_FACT, READABILITY_FACT].includes(row.content)),
      ).toBe(false);

      const graphPrompts: string[] = [];
      const graphRouter = {
        async object(_role: string, input: { prompt?: string }) {
          const prompt = input.prompt ?? '';
          graphPrompts.push(prompt);
          return {
            ok: true,
            modelId: 'fake-graph',
            degraded: false,
            object: {
              relationships: prompt.includes(ORDINARY_FACT)
                ? [
                    {
                      subject: { label: 'OPS16 Owner', kind: 'person' },
                      subjectSpan: 'OPS16 Owner',
                      predicate: 'works_at',
                      predicateSpan: 'works at',
                      object: { label: 'OPS16 Northwind', kind: 'organization' },
                      objectSpan: 'OPS16 Northwind',
                      evidenceQuote: ORDINARY_FACT,
                      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
                      confidence: 0.95,
                    },
                  ]
                : [],
            },
          };
        },
      } as unknown as ExecutorDeps['router'];
      const graphSync = await syncKnowledgeGraph(
        { graphSync: new FirestoreKnowledgeGraphSyncRepository(store), router: graphRouter },
        { agentId },
      );
      expect(graphSync).toMatchObject({ candidates: 1, processed: 1, relationships: 1 });
      expect(graphPrompts.some((prompt) => prompt.includes(ORDINARY_FACT))).toBe(true);
      expect(
        graphPrompts.some(
          (prompt) => prompt.includes(FIXTURE_FACT) || prompt.includes(READABILITY_FACT),
        ),
      ).toBe(false);
      const graphRecall = await recallKnowledgeGraph(
        new FirestoreGraphRecallRepository(store, SPACE),
        {
          agentId,
          queryText: 'Where does OPS16 Owner work?',
          queryEmbedding: VECTOR,
        },
      );
      expect(graphRecall.block).toContain('OPS16 Northwind');
      expect(graphRecall.sources.some((source) => source.kind === 'knowledge_graph')).toBe(true);
      expect(graphRecall.block).not.toContain('Fixture Lab');
      expect(graphRecall.block).not.toContain('Readability Studio');

      const commitmentFixtureId = randomUUID();
      await store.doc('messages', commitmentFixtureId).set(
        encodeRecord({
          id: commitmentFixtureId,
          conversationId: mixed.conversationId,
          taskId: null,
          role: 'user',
          parts: [],
          text: FIXTURE_TEXT,
          origin: 'chat',
          channelMessageId: `visual-qa:${randomUUID()}:commitment`,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(Date.now() + 2),
        }),
      );
      const readabilityCommitmentId = randomUUID();
      await store.doc('messages', readabilityCommitmentId).set(
        encodeRecord({
          id: readabilityCommitmentId,
          conversationId: mixed.conversationId,
          taskId: null,
          role: 'user',
          parts: [],
          text: READABILITY_TEXT,
          origin: 'chat',
          channelMessageId: `readability-${randomUUID()}-04-user`,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(Date.now() + 3),
        }),
      );
      const commitmentStarted = deferred<string>();
      const releaseCommitment = deferred();
      let commitmentGateUsed = false;
      const commitmentFixtureRows = fakeRouter(undefined, async (prompt) => {
        if (!commitmentGateUsed) {
          commitmentGateUsed = true;
          commitmentStarted.resolve(prompt);
          await releaseCommitment.promise;
        }
      });
      const commitmentTask = await lease();
      const commitmentRun = extractCommitments(
        { db, router: commitmentFixtureRows.router, persistence },
        {
          agentId,
          taskId: commitmentTask.taskId,
          lease: () => commitmentTask.lease,
          since: since(),
        },
      );
      const commitmentPrompt = await pauseWorkerForCleanup(
        commitmentStarted.promise,
        commitmentRun,
        () => releaseCommitment.resolve(),
        () => store.doc('messages', commitmentFixtureId).delete(),
        'Commitment extraction',
      );

      const savedCommitments = await commitmentRun;

      expect(
        commitmentFixtureRows.prompts.filter((row) => row.pass === 'commitments'),
      ).toHaveLength(1);
      expect(commitmentPrompt).toContain(ORDINARY_TEXT);
      expect(commitmentPrompt).not.toContain(FIXTURE_TEXT);
      expect(commitmentPrompt).not.toContain(READABILITY_TEXT);
      expect(savedCommitments.saved).toBe(1);
      const stored = await store.collection('commitments').where('agentId', '==', agentId).get();
      expect(stored.docs).toHaveLength(1);
      expect(stored.docs[0]?.data()).toMatchObject({
        title: ORDINARY_COMMITMENT,
        sourceMessageId: ordinary.id,
        status: 'open',
      });
      expect(stored.docs.some((doc) => doc.get('title') === FIXTURE_COMMITMENT)).toBe(false);
      expect(stored.docs.some((doc) => doc.get('title') === READABILITY_COMMITMENT)).toBe(false);
      expect(String(stored.docs[0]?.get('sourceOccurrenceKey'))).toContain(ordinary.id);
      expect(String(stored.docs[0]?.get('sourceOccurrenceKey'))).not.toContain(commitmentFixtureId);
      expect(String(stored.docs[0]?.get('sourceOccurrenceKey'))).not.toContain(
        readabilityCommitmentId,
      );
      expect(sqlAccesses).toEqual([]);
    });
  },
);
