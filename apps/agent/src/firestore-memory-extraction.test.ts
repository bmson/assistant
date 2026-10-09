import { createHash, randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import { runMemoryExtraction } from '@assistant/core/memory/extraction';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreCommitmentMutationRepository,
  FirestoreMemoryExtractionRepository,
  FirestoreProfileOccasionCommandRepository,
} from '@assistant/firestore';
import { type ExecutionPersistence, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentKey,
  encodeRecord,
  type InstallationStore,
} from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const MINUTE = 60_000;
const SPACE = {
  provider: 'synthetic',
  model: 'extraction-fixture',
  dimensions: 1536,
  revision: '1',
};

type Fact = {
  content: string;
  subject?: string;
  category?: 'knowledge' | 'experience';
  relationship?: string;
};
type Occasion = { subject: string; month: number; day: number; notes?: string };
type Loop = { title: string; kind?: string };
type Script = {
  facts?: Fact[];
  occasions?: Occasion[];
  loops?: Loop[];
  resolved?: string[];
  fail?: boolean;
};

/**
 * A model that answers per conversation, keyed by a marker word in the
 * transcript, and records which conversations each pass sent it.
 */
function scriptedRouter(scripts: Record<string, Script>) {
  const modelSubject = (subject: string) =>
    subject.toLowerCase() === 'owner'
      ? { type: 'owner' }
      : { type: 'new_person_candidate', name: subject };
  const calls: Array<{ pass: 'memory' | 'commitments'; marker: string }> = [];
  const markerOf = (prompt: string) => {
    const marker = Object.keys(scripts).find((key) => prompt.includes(key));
    if (!marker) throw new Error(`Unexpected transcript: ${prompt.slice(0, 80)}`);
    return marker;
  };
  const router = {
    async object(_role: string, input: { prompt: string }) {
      const pass = input.prompt.startsWith('Conversation (source trust:')
        ? 'memory'
        : 'commitments';
      const marker = markerOf(input.prompt);
      const ownerMessageIds = [...input.prompt.matchAll(/\[message_id=([0-9a-f-]{36})\] owner:/g)]
        .map((match) => match[1])
        .filter((id): id is string => Boolean(id));
      const latestOwnerMessageId = ownerMessageIds.at(-1);
      calls.push({ pass, marker });
      const script = scripts[marker] ?? {};
      if (pass === 'memory' && script.fail) throw new Error('provider unavailable');
      const object =
        pass === 'memory'
          ? {
              facts: (script.facts ?? []).map((fact) => ({
                content: fact.content,
                kind: 'fact',
                category: fact.category ?? 'knowledge',
                subject: modelSubject(fact.subject ?? 'owner'),
                relationship: fact.relationship ?? '',
                importance: 3,
                confidence: 0.9,
                domain: 'personal',
                validFrom: '',
              })),
              occasions: (script.occasions ?? []).map((occasion) => ({
                kind: 'birthday',
                label: '',
                year: null,
                notes: '',
                ...occasion,
                subject: modelSubject(occasion.subject),
              })),
            }
          : {
              commitments: (script.loops ?? []).map((loop) => ({
                kind: loop.kind ?? 'promise',
                title: loop.title,
                details: '',
                nextAction: '',
                dueAt: '',
                confidence: 0.9,
                sourceMessageIds: latestOwnerMessageId ? [latestOwnerMessageId] : [],
              })),
              resolvedTitles: script.resolved ?? [],
            };
      return { ok: true, modelId: 'fixture', degraded: false, object };
    },
    async embeddingSpace() {
      return SPACE;
    },
    async embeddingSpaceKey() {
      return embeddingSpaceIdentityKey(SPACE);
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, ...new Array(1535).fill(0)]);
    },
  };
  return { router: router as unknown as ExecutorDeps['router'], calls };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore memory extraction job', () => {
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let sqlAccesses: string[];
  let db: Db;
  let clock: number;

  const unavailable = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          sqlAccesses.push(`${name}.${String(property)}`);
          throw new Error(`Unexpected ${name} access: ${String(property)}`);
        },
      },
    );

  beforeEach(async () => {
    store = emulatorStore();
    sqlAccesses = [];
    db = unavailable('db') as Db;
    clock = Date.now() - 60 * MINUTE;
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
    await store.doc('contacts', ownerContactId).set(
      encodeRecord({
        id: ownerContactId,
        name: 'Sam Owner',
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

  /** A conversation whose messages are newer than every earlier seeded one. */
  async function conversation(
    marker: string,
    options: { trust?: string; agent?: string; lines?: number; source?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await store.doc('conversations', id).set(
      encodeRecord({
        id,
        agentId: options.agent ?? agentId,
        title: marker,
        channel: 'chat',
        trust: options.trust ?? 'owner',
        archivedAt: null,
        modelOverride: null,
        isPrimary: false,
        metadata: {},
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    for (let index = 0; index < (options.lines ?? 2); index += 1) {
      clock += MINUTE;
      const messageId = randomUUID();
      await store.doc('messages', messageId).set(
        encodeRecord({
          id: messageId,
          conversationId: id,
          taskId: null,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [],
          text: `${marker}: ${options.source ?? `line ${index} of a conversation worth remembering`}`,
          origin: 'chat',
          channelMessageId: null,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(clock),
        }),
      );
    }
    return id;
  }

  async function extractionTask(): Promise<string> {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
    });
    return task.id;
  }

  async function memories() {
    const rows = await store.collection('memories').where('agentId', '==', agentId).get();
    return rows.docs.map((doc) => doc.data());
  }

  async function checkpoint(taskId: string): Promise<string[]> {
    return (await store.doc('codeJobCheckpoints', taskId).get()).get('keys') ?? [];
  }

  async function extractionLease() {
    const taskId = await extractionTask();
    const lease = await persistence.tasks.claim(taskId);
    if (!lease?.leaseToken) throw new Error('could not claim memory extraction task');
    return { taskId, lease: { taskId, leaseToken: lease.leaseToken } };
  }

  it('pages past fixture-created commitments before building title-resolution candidates', async () => {
    const ordinaryConversationId = await conversation('RESOLUTION_ORDINARY', { lines: 1 });
    const fixtureConversationId = await conversation('RESOLUTION_FIXTURE', { lines: 1 });
    await store.doc('conversations', fixtureConversationId).update({
      metadata: { visualQaRunId: 'resolution-fixture-run' },
    });
    const ordinaryId = randomUUID();
    const baseCommitment = {
      agentId,
      sourceMessageId: null,
      sourceTaskId: null,
      sourceOccurrenceKey: null,
      reopenedFromId: null,
      reopenOperationId: null,
      kind: 'promise',
      details: '',
      nextAction: '',
      status: 'open',
      dueAt: null,
      snoozedUntil: null,
      resolvedAt: null,
      resolution: null,
      confidence: '0.90',
      contentHash: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const fixtureRows = Array.from({ length: 101 }, (_, index) => {
      const id = randomUUID();
      return {
        ...baseCommitment,
        id,
        conversationId: fixtureConversationId,
        title: `Fixture-only resolvable loop ${index}`,
        contentHash: randomUUID(),
      };
    });
    const ordinaryRow = {
      ...baseCommitment,
      id: ordinaryId,
      conversationId: ordinaryConversationId,
      title: 'Ordinary resolvable loop',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const batch = store.db.batch();
    for (const row of fixtureRows) batch.set(store.doc('commitments', row.id), encodeRecord(row));
    batch.set(store.doc('commitments', ordinaryRow.id), encodeRecord(ordinaryRow));
    await batch.commit();

    const found = await new FirestoreMemoryExtractionRepository(store, SPACE).activeCommitments(
      agentId,
      1,
    );
    expect(found.map((row) => row.id)).toEqual([ordinaryId]);
  });

  it('saves facts, occasions, people, and open loops with PostgreSQL unreachable', async () => {
    const dana = randomUUID();
    const danaConversationId = randomUUID();
    await store.doc('conversations', danaConversationId).set(
      encodeRecord({
        id: danaConversationId,
        agentId,
        title: 'Existing owner loop source',
        channel: 'chat',
        trust: 'owner',
        metadata: {},
      }),
    );
    await store.doc('commitments', dana).set(
      encodeRecord({
        id: dana,
        agentId,
        conversationId: danaConversationId,
        sourceMessageId: null,
        sourceTaskId: null,
        kind: 'promise',
        title: 'Send the tax forms to Dana',
        details: '',
        nextAction: '',
        status: 'open',
        snoozedUntil: null,
        dueAt: null,
        resolvedAt: null,
        resolution: null,
        confidence: '0.90',
        contentHash: 'seeded',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const foreign = await conversation('FOREIGN', { agent: randomUUID() });
    const external = await conversation('EXTERNAL', { trust: 'external' });
    const owned = await conversation('OWNED', {
      source:
        'Sam prefers aisle seats, and Maya is training for the Berlin marathon. Maya’s birthday is June 9.',
    });
    const { router, calls } = scriptedRouter({
      OWNED: {
        facts: [
          { content: 'Sam prefers aisle seats on long flights.' },
          {
            content: 'Maya is training for the Berlin marathon.',
            subject: 'Maya',
            relationship: 'sister',
          },
          { content: 'Sam visited the new ramen place on Friday.', category: 'experience' },
        ],
        occasions: [{ subject: 'Maya', month: 6, day: 9, notes: 'running socks' }],
        loops: [{ title: 'Book the flights to Lisbon' }],
        resolved: ['Send the tax forms to Dana'],
      },
      EXTERNAL: {
        facts: [{ content: 'Sam should wire money to a new account today.' }],
        loops: [{ title: 'Wire the money to the new account' }],
      },
      FOREIGN: { facts: [{ content: 'Another owner has a secret project.' }] },
    });
    const deps: ExecutorDeps = {
      db,
      router,
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence,
    };

    const taskId = await extractionTask();
    const result = await executeTask(deps, taskId);

    expect(result.outcome, result.detail).toBe('done');
    expect(result.detail).toContain('extraction: 4 saved (1 quarantined, 1 new people)');
    expect(result.detail).toContain(
      '1 occasion(s), 0 occasion(s) rejected, from 2 conversation(s)',
    );
    expect(result.detail).toContain('open loops 1 saved (0 duplicate)');
    expect(sqlAccesses).toEqual([]);
    // Another owner's thread is never read, and only the owner's thread is
    // mined for open loops.
    expect(calls).not.toContainEqual(expect.objectContaining({ marker: 'FOREIGN' }));
    expect(calls).not.toContainEqual({ pass: 'commitments', marker: 'EXTERNAL' });
    expect(foreign).toBeTruthy();
    expect(external).toBeTruthy();

    const saved = await memories();
    expect(saved).toHaveLength(4);
    for (const row of saved) {
      expect(row.embeddingSpace).toBeTruthy();
      expect(row.source).toBe('extraction');
      expect(row.sourceTaskId).toBe(taskId);
    }
    const byContent = Object.fromEntries(saved.map((row) => [row.content, row]));
    expect(byContent['Sam prefers aisle seats on long flights.']).toMatchObject({
      quarantined: false,
      originTrust: 'owner',
      subjectContactId: ownerContactId,
      expiresAt: null,
    });
    expect(byContent['Sam visited the new ramen place on Friday.']?.expiresAt).not.toBeNull();
    expect(byContent['Sam should wire money to a new account today.']).toMatchObject({
      quarantined: true,
      originTrust: 'external',
    });

    const maya = await store.collection('contacts').where('name', '==', 'Maya').get();
    expect(maya.size).toBe(1);
    const mayaId = maya.docs[0]?.get('id');
    expect(byContent['Maya is training for the Berlin marathon.']?.subjectContactId).toBe(mayaId);
    const occasions = await store.collection('occasions').where('agentId', '==', agentId).get();
    expect(occasions.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({ contactId: mayaId, month: 6, day: 9, notes: 'running socks' }),
    ]);

    const loops = await store.collection('commitments').where('agentId', '==', agentId).get();
    const byTitle = Object.fromEntries(loops.docs.map((doc) => [doc.get('title'), doc.data()]));
    expect(byTitle['Book the flights to Lisbon']).toMatchObject({
      status: 'open',
      conversationId: owned,
      sourceTaskId: taskId,
    });
    expect(byTitle['Send the tax forms to Dana']).toMatchObject({ status: 'resolved' });
    expect(byTitle['Wire the money to the new account']).toBeUndefined();
    expect((await checkpoint(taskId)).sort()).toEqual(
      [`commitments:${owned}`, `memory:${external}`, `memory:${owned}`].sort(),
    );

    // A later run sees the same facts and loops again and saves nothing new,
    // and noticing a loop again does not reset its idle clock.
    const lisbonUpdatedAt = byTitle['Book the flights to Lisbon']?.updatedAt;
    const again = await executeTask(deps, await extractionTask());
    expect(again.outcome).toBe('done');
    expect(again.detail).toContain('extraction: 0 saved');
    expect(again.detail).toContain('4 duplicate');
    expect(again.detail).toContain('open loops 0 saved (1 duplicate)');
    expect(await memories()).toHaveLength(4);
    const lisbon = await store
      .collection('commitments')
      .where('title', '==', 'Book the flights to Lisbon')
      .get();
    expect(lisbon.size).toBe(1);
    expect(lisbon.docs[0]?.get('updatedAt')).toEqual(lisbonUpdatedAt);
    expect(sqlAccesses).toEqual([]);
  });

  it('retains a closed source occurrence across replay and accepts a later owner occurrence', async () => {
    const marker = 'COMMITMENT_REPLAY';
    const conversationId = await conversation(marker, {
      lines: 1,
      source: 'I will book the flights to Lisbon before Friday.',
    });
    const script: Script = { loops: [{ title: 'Book the Lisbon flights' }] };
    const { router } = scriptedRouter({ [marker]: script });
    const deps: ExecutorDeps = {
      db,
      router,
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence,
    };
    const run = async () => executeTask(deps, await extractionTask());

    expect((await run()).outcome).toBe('done');
    let saved = await store
      .collection('commitments')
      .where('conversationId', '==', conversationId)
      .get();
    expect(saved.size).toBe(1);
    const original = saved.docs[0];
    if (!original) throw new Error('commitment was not created');
    expect(original.get('id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(documentKey(String(original.get('id')))).toBe(original.id);
    await original.ref.update({ status: 'dismissed', resolution: 'Dismissed by owner' });

    // The model can paraphrase the same source on a later task. The stable
    // source identity blocks a second active row and preserves the edit.
    const scriptLoop = (script.loops ?? [])[0];
    if (!scriptLoop) throw new Error('commitment fixture was not created');
    scriptLoop.title = 'Arrange Lisbon airfare';
    expect((await run()).outcome).toBe('done');
    saved = await store
      .collection('commitments')
      .where('conversationId', '==', conversationId)
      .get();
    expect(saved.size).toBe(1);
    expect(saved.docs[0]?.get('status')).toBe('dismissed');

    clock += MINUTE;
    const laterMessageId = randomUUID();
    await store.doc('messages', laterMessageId).set(
      encodeRecord({
        id: laterMessageId,
        conversationId,
        taskId: null,
        role: 'user',
        parts: [],
        text: `${marker}: I am reopening the flight booking for my next trip.`,
        origin: 'chat',
        channelMessageId: null,
        embedding: null,
        hiddenAt: null,
        createdAt: new Date(clock),
      }),
    );
    expect((await run()).outcome).toBe('done');
    saved = await store
      .collection('commitments')
      .where('conversationId', '==', conversationId)
      .get();
    expect(saved.size).toBe(2);
    expect(saved.docs.map((doc) => doc.get('status')).sort()).toEqual(['dismissed', 'open']);
    expect(
      new Set(saved.docs.map((doc) => doc.get('sourceOccurrenceKey')).filter(Boolean)).size,
    ).toBe(2);

    const latest = saved.docs.find((doc) => doc.get('status') === 'open');
    if (!latest) throw new Error('later evidence occurrence is not open');
    const closedAt = new Date(clock + 1000);
    await latest.ref.update({
      status: 'resolved',
      resolvedAt: closedAt,
      resolution: 'Closed before explicit reopen',
      updatedAt: closedAt,
    });
    const mutations = new FirestoreCommitmentMutationRepository(store, agentId);
    const reopened = await mutations.reopen(String(latest.get('id')), closedAt, randomUUID());
    expect(reopened?.replay).toBe(false);
    if (!reopened) throw new Error('manual occurrence did not reopen');

    // A model's old title-only resolution output cannot close the manual
    // occurrence: until extraction has source-cited resolution evidence, this
    // path requires a direct owner control.
    script.resolved = [String(latest.get('title'))];
    expect((await run()).outcome).toBe('done');
    expect((await store.doc('commitments', reopened.commitmentId).get()).get('status')).toBe(
      'open',
    );
  });

  it('does not let eleven closed matching histories block extraction or reopen their source', async () => {
    const marker = 'LONG_COMMITMENT_HISTORY';
    const conversationId = await conversation(marker, {
      lines: 1,
      source: 'I will send the forms tomorrow.',
    });
    const ownerMessages = await store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .get();
    const oldSource = String(ownerMessages.docs[0]?.get('id'));
    const hash = createHash('sha256').update('promise\nsend the forms\n').digest('hex');
    for (let index = 0; index < 11; index += 1) {
      const id = randomUUID();
      await store.doc('commitments', id).set(
        encodeRecord({
          id,
          agentId,
          conversationId,
          sourceMessageId: oldSource,
          sourceTaskId: null,
          sourceOccurrenceKey: `older:${index}`,
          kind: 'promise',
          title: 'Send the forms',
          details: '',
          nextAction: '',
          status: 'dismissed',
          dueAt: null,
          snoozedUntil: null,
          resolvedAt: new Date(),
          resolution: 'Dismissed by owner',
          confidence: '1.00',
          contentHash: hash,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    }
    const { router } = scriptedRouter({
      [marker]: { loops: [{ title: 'Ask about the next trip', kind: 'question' }] },
    });
    const result = await executeTask(
      {
        db,
        router,
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence,
      },
      await extractionTask(),
    );
    expect(result.outcome, result.detail).toBe('done');
    const saved = await store.collection('commitments').where('agentId', '==', agentId).get();
    expect(saved.size).toBe(12);
    expect(saved.docs.filter((doc) => doc.get('status') === 'dismissed')).toHaveLength(11);
    expect(
      saved.docs.filter((doc) => doc.get('status') === 'open').map((doc) => doc.get('title')),
    ).toEqual(['Ask about the next trip']);
  });

  it('saves occasion-only output before checkpointing and validates new people against source text', async () => {
    const source = 'The owner says Élín’s birthday is June 9.';
    const conversationId = await conversation('OCCASION_ONLY', { source });
    const { router } = scriptedRouter({
      OCCASION_ONLY: { occasions: [{ subject: 'Élín', month: 6, day: 9 }] },
    });
    const { taskId, lease } = await extractionLease();
    const result = await runMemoryExtraction(
      { db, router, persistence },
      {
        taskId,
        agentId,
        lease: () => lease,
      },
    );
    expect(result).toMatchObject({ saved: 0, occasionsSaved: 1, occasionsRejected: 0 });
    expect(await checkpoint(taskId)).toContain(`memory:${conversationId}`);
    const people = await store.collection('contacts').where('name', '==', 'Élín').get();
    expect(people.size).toBe(1);
    const saved = await store.collection('occasions').where('agentId', '==', agentId).get();
    expect(saved.docs.map((doc) => doc.data())).toContainEqual(
      expect.objectContaining({ contactId: people.docs[0]?.get('id'), month: 6, day: 9 }),
    );
  });

  it('keeps an owner date correction and rejects stale extracted dates on replay', async () => {
    const commands = new FirestoreProfileOccasionCommandRepository(store, agentId);
    const input = {
      contactId: ownerContactId,
      kind: 'birthday' as const,
      label: 'Birthday',
      month: 4,
      day: 12,
      year: 1980,
      leadDays: 7,
      notes: 'Owner corrected the date',
    };
    await commands.create(input);
    const original = (
      await store.collection('occasions').where('contactId', '==', ownerContactId).get()
    ).docs[0];
    if (!original) throw new Error('Expected the owner birthday');
    const originalId = original.get('id') as string;
    await commands.update(originalId, {
      ...input,
      day: 13,
      notes: 'Owner correction is authoritative; Later source',
    });

    const { lease } = await extractionLease();
    const applied = await persistence.memoryExtraction?.applyMemories({
      agentId,
      lease,
      checkpointKey: 'fs10:date-correction-replay',
      originTrust: 'owner',
      quarantined: false,
      facts: [],
      occasions: [
        {
          subject: 'Sam Owner',
          contactId: ownerContactId,
          kind: 'birthday',
          label: 'Birthday',
          month: 4,
          day: 12,
          year: 1980,
          notes: 'Historical source date',
        },
        {
          subject: 'Sam Owner',
          contactId: ownerContactId,
          kind: 'birthday',
          label: 'Birthday',
          month: 4,
          day: 13,
          year: null,
          notes: 'Later source',
        },
      ],
    });
    expect(applied).toMatchObject({ occasionsSaved: 0, occasionsRejected: 1 });
    const rows = await store.collection('occasions').where('contactId', '==', ownerContactId).get();
    expect(rows.size).toBe(1);
    expect(rows.docs.find((row) => row.get('id') === originalId)?.data()).toMatchObject({
      id: originalId,
      day: 13,
      notes: 'Owner correction is authoritative; Later source',
      ownerConfirmed: true,
      originTrust: 'owner',
    });
    expect(rows.docs.find((row) => row.get('day') === 12)).toBeUndefined();
  });

  it('reuses prepared model output after a storage failure in a fresh repository instance', async () => {
    const conversationId = await conversation('PREPARED_RECOVERY', {
      source: 'The owner prefers quiet mornings and reads before breakfast every day.',
    });
    const { router, calls } = scriptedRouter({
      PREPARED_RECOVERY: {
        facts: [{ content: 'The owner prefers quiet mornings before breakfast.' }],
      },
    });
    const first = await extractionLease();
    const repository = persistence.memoryExtraction;
    if (!repository) throw new Error('memory extraction repository is unavailable');
    repository.applyMemories = async () => {
      throw new Error('simulated persistence interruption');
    };
    const failed = await runMemoryExtraction(
      { db, router, persistence },
      { taskId: first.taskId, agentId, lease: () => first.lease },
    );
    expect(failed.failedBatches).toEqual([{ conversationId, category: 'storage' }]);
    expect(calls.filter((call) => call.pass === 'memory')).toHaveLength(1);
    const prepared = await store.collection('preparedMemoryExtractions').get();
    expect(prepared.size).toBe(1);
    expect(prepared.docs[0]?.get('sourceHash')).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.docs[0]?.get('extractionVersion')).toBe('memory-extraction-v3');
    const preparedFact = prepared.docs[0]?.get('payload').facts[0];
    expect(preparedFact.embeddingSpaceKey).toBe(embeddingSpaceIdentityKey(SPACE));

    const restartedPersistence = {
      ...persistence,
      memoryExtraction: new FirestoreMemoryExtractionRepository(store, SPACE),
    };
    const second = await extractionLease();
    const resumed = await runMemoryExtraction(
      { db, router, persistence: restartedPersistence },
      { taskId: second.taskId, agentId, lease: () => second.lease },
    );
    expect(resumed.saved).toBe(1);
    const saved = await memories();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.embeddingSpaceKey).toBe(preparedFact.embeddingSpaceKey);
    expect(saved[0]?.embedding.toArray()).toEqual(preparedFact.embedding);
    expect(calls.filter((call) => call.pass === 'memory')).toHaveLength(1);
    expect(await checkpoint(second.taskId)).toContain(`memory:${conversationId}`);
    expect((await store.collection('preparedMemoryExtractions').get()).size).toBe(0);
  });

  it.each([
    'missing-fact',
    'unknown-fact',
    'different-fact',
    'unknown-payload',
    'different-payload',
  ])('refuses to relabel prepared vectors on restart: %s', async (variant) => {
    const conversationId = await conversation('PREPARED_IDENTITY', {
      source: 'The owner prefers quiet mornings and reads before breakfast every day.',
    });
    const { router, calls } = scriptedRouter({
      PREPARED_IDENTITY: {
        facts: [{ content: 'The owner prefers quiet mornings before breakfast.' }],
      },
    });
    const embed = vi.spyOn(router, 'embed');
    const first = await extractionLease();
    const repository = persistence.memoryExtraction;
    if (!repository) throw new Error('memory extraction repository is unavailable');
    repository.applyMemories = async () => {
      throw new Error('simulated persistence interruption');
    };
    await runMemoryExtraction(
      { db, router, persistence },
      { taskId: first.taskId, agentId, lease: () => first.lease },
    );
    const prepared = (await store.collection('preparedMemoryExtractions').get()).docs[0];
    if (!prepared) throw new Error('prepared extraction was not saved');
    const payload = prepared.get('payload');
    if (variant === 'missing-fact') delete payload.facts[0].embeddingSpaceKey;
    if (variant === 'unknown-fact') payload.facts[0].embeddingSpaceKey = null;
    if (variant === 'different-fact') payload.facts[0].embeddingSpaceKey = 'f'.repeat(64);
    if (variant === 'unknown-payload') payload.embeddingSpaceKey = null;
    if (variant === 'different-payload') payload.embeddingSpaceKey = 'f'.repeat(64);
    await prepared.ref.update({ payload });
    const originalPayload = structuredClone(payload);
    const restarted = new FirestoreMemoryExtractionRepository(store, SPACE);
    const apply = vi.spyOn(restarted, 'applyMemories');
    const second = await extractionLease();
    await expect(
      runMemoryExtraction(
        { db, router, persistence: { ...persistence, memoryExtraction: restarted } },
        { taskId: second.taskId, agentId, lease: () => second.lease },
      ),
    ).rejects.toThrow('Prepared memory vectors belong to a different embedding space');
    expect(calls.filter((call) => call.pass === 'memory')).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(await memories()).toEqual([]);
    expect(await checkpoint(second.taskId)).not.toContain(`memory:${conversationId}`);
    expect((await prepared.ref.get()).get('payload')).toEqual(originalPayload);
  });

  it('does not create an orphan person for a duplicate fact and isolates occasion identity overflow', async () => {
    const extraction = persistence.memoryExtraction;
    if (!extraction) throw new Error('missing memory extraction repository');
    const duplicateContent = 'A previously stored fact names a new candidate.';
    const duplicateHash = createHash('sha256').update(duplicateContent).digest('hex');
    await store.doc('memoryContentHashes', duplicateHash).set({ memoryId: randomUUID() });
    const first = await extractionLease();
    const duplicate = await extraction.applyMemories({
      agentId,
      lease: first.lease,
      checkpointKey: 'memory:duplicate-fact',
      originTrust: 'owner',
      quarantined: false,
      facts: [
        {
          content: duplicateContent,
          contentHash: duplicateHash,
          embedding: [1, ...new Array(1535).fill(0)],
          embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
          category: 'knowledge',
          kind: 'fact',
          importance: 3,
          confidence: '0.90',
          domain: 'personal',
          validFrom: null,
          expiresAt: null,
          subject: 'Orphan Person',
          relationship: '',
        },
      ],
      occasions: [],
    });
    expect(duplicate).toMatchObject({ duplicates: 1, contactsCreated: 0 });
    expect(
      (await store.collection('contacts').where('name', '==', 'Orphan Person').get()).size,
    ).toBe(0);

    const mayaId = randomUUID();
    await store.doc('contacts', mayaId).set(
      encodeRecord({
        id: mayaId,
        name: 'Maya',
        aliases: [],
        emails: [],
        phones: [],
        relationship: 'friend',
        notes: '',
        trust: 'unknown',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const dates: Array<{ month: number; day: number }> = [];
    for (let month = 1; month <= 12 && dates.length < 101; month += 1) {
      for (let day = 1; day <= 31 && dates.length < 101; day += 1) {
        if (month === 12 && day === 31) continue;
        dates.push({ month, day });
      }
    }
    const now = new Date();
    const legacyBatch = store.db.batch();
    for (const date of dates) {
      const id = randomUUID();
      legacyBatch.create(
        store.doc('occasions', id),
        encodeRecord({
          id,
          agentId,
          contactId: mayaId,
          kind: 'birthday',
          label: '',
          month: date.month,
          day: date.day,
          year: null,
          recurrence: 'annual',
          leadDays: 7,
          notes: '',
          originTrust: 'owner',
          quarantined: false,
          ownerConfirmed: true,
          source: 'manual',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    await legacyBatch.commit();

    const second = await extractionLease();
    const saved = await extraction.applyMemories({
      agentId,
      lease: second.lease,
      checkpointKey: 'memory:101-occasions',
      originTrust: 'owner',
      quarantined: false,
      facts: [],
      occasions: [
        { subject: 'Maya', kind: 'birthday', label: '', month: 12, day: 31, year: null, notes: '' },
      ],
    });
    expect(saved).toMatchObject({ occasionsSaved: 1, occasionsRejected: 0 });

    for (let copy = 0; copy < 2; copy += 1) {
      const id = randomUUID();
      await store.doc('occasions', id).set(
        encodeRecord({
          id,
          agentId,
          contactId: mayaId,
          kind: 'birthday',
          label: '',
          month: 11,
          day: 30,
          year: null,
          recurrence: 'annual',
          leadDays: 7,
          notes: '',
          originTrust: 'owner',
          quarantined: false,
          ownerConfirmed: true,
          source: 'manual',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    const third = await extractionLease();
    const ambiguous = await extraction.applyMemories({
      agentId,
      lease: third.lease,
      checkpointKey: 'memory:ambiguous-occasion',
      originTrust: 'owner',
      quarantined: false,
      facts: [],
      occasions: [
        { subject: 'Maya', kind: 'birthday', label: '', month: 11, day: 30, year: null, notes: '' },
      ],
    });
    expect(ambiguous).toMatchObject({ occasionsSaved: 0, occasionsRejected: 1 });
  });

  it('resumes a reclaimed run after its last committed conversation, and fences the old lease', async () => {
    const first = await conversation('FIRST');
    const second = await conversation('SECOND');
    const scripts: Record<string, Script> = {
      SECOND: { facts: [{ content: 'Sam switched to decaf in September.' }] },
      FIRST: { facts: [{ content: 'Sam is learning to play the cello.' }], fail: true },
    };
    const { router, calls } = scriptedRouter(scripts);
    const taskId = await extractionTask();
    const claim = async (leaseToken: string) =>
      store.doc('tasks', taskId).update({
        status: 'running',
        leaseToken,
        lockedUntil: new Date(Date.now() + 5 * MINUTE),
      });
    const run = (leaseToken: string) =>
      runMemoryExtraction(
        { db, router, persistence },
        { taskId, agentId, lease: () => ({ taskId, leaseToken }) },
      );

    // The most recently active conversation goes first and commits; the
    // provider then fails on the next one.
    await claim('lease-a');
    await expect(run('lease-a')).rejects.toThrow('provider unavailable');
    expect(calls.map((call) => call.marker)).toEqual(['SECOND', 'FIRST']);
    expect(await checkpoint(taskId)).toEqual([`memory:${second}`]);
    expect((await memories()).map((row) => row.content)).toEqual([
      'Sam switched to decaf in September.',
    ]);

    // The lease expires and another worker reclaims the task.
    await store.doc('tasks', taskId).update({ lockedUntil: new Date(Date.now() - MINUTE) });
    await claim('lease-b');

    // The old holder can no longer commit anything, even a step not yet taken.
    scripts.FIRST = { facts: [{ content: 'Sam is learning to play the cello.' }] };
    const extraction = persistence.memoryExtraction;
    if (!extraction) throw new Error('missing memory extraction repository');
    await expect(
      extraction.applyMemories({
        agentId,
        lease: { taskId, leaseToken: 'lease-a' },
        checkpointKey: `memory:${first}`,
        originTrust: 'owner',
        quarantined: false,
        facts: [],
        occasions: [],
      }),
    ).rejects.toThrow('task lease lost');
    await expect(run('lease-a')).rejects.toThrow('task lease lost');
    expect(await checkpoint(taskId)).toEqual([`memory:${second}`]);
    expect(await memories()).toHaveLength(1);

    // The new holder skips the committed conversation without asking the
    // model about it again, and finishes the rest.
    calls.length = 0;
    const resumed = await run('lease-b');
    expect(calls.filter((call) => call.pass === 'memory').map((call) => call.marker)).toEqual([
      'FIRST',
    ]);
    expect(resumed).toMatchObject({ conversationsScanned: 1, saved: 1, duplicates: 0 });
    expect((await checkpoint(taskId)).sort()).toEqual(
      [`memory:${first}`, `memory:${second}`].sort(),
    );
    expect((await memories()).map((row) => row.content).sort()).toEqual([
      'Sam is learning to play the cello.',
      'Sam switched to decaf in September.',
    ]);
    expect(sqlAccesses).toEqual([]);
  });
});
