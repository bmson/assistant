import { randomUUID } from 'node:crypto';
import { toolCallReplayKeysForStart } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreMaintenanceRepository } from './maintenance.js';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space = { provider: 'synthetic', model: 'maintenance', dimensions: 1536, revision: '1' };
const vector = (seed: number) => Array.from({ length: 1536 }, (_, i) => (i === seed ? 1 : 0.001));
const DAY = 86_400_000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore maintenance repository', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let now: Date;
  let repository: FirestoreMaintenanceRepository;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const put = (collection: string, row: Record<string, unknown> & { id: string }) =>
    store.doc(collection, row.id).set(encodeRecord(row));
  const exists = async (collection: string, id: string) =>
    (await store.doc(collection, id).get()).exists;
  const read = async (collection: string, id: string) =>
    decodeRecord<Record<string, unknown>>((await store.doc(collection, id).get()).data());

  beforeEach(async () => {
    now = new Date('2026-09-24T12:00:00.000Z');
    store = emulatorStore(() => now);
    repository = new FirestoreMaintenanceRepository(store, agentId, space);
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
  });

  afterEach(async () => disposeStore(store));

  it('expires only pending or snoozed suggestions past their TTL', async () => {
    const suggestion = (status: string, expiresAt: Date) => {
      const id = randomUUID();
      return put('suggestions', { id, agentId, status, expiresAt, updatedAt: ago(DAY) }).then(
        () => id,
      );
    };
    const pending = await suggestion('pending', ago(1));
    const snoozed = await suggestion('snoozed', ago(DAY));
    const future = await suggestion('pending', new Date(now.getTime() + DAY));
    const accepted = await suggestion('accepted', ago(DAY));

    expect(await repository.expireSuggestions()).toBe(2);
    expect(await read('suggestions', pending)).toMatchObject({ status: 'expired', updatedAt: now });
    expect((await read('suggestions', snoozed)).status).toBe('expired');
    expect((await read('suggestions', future)).status).toBe('pending');
    expect((await read('suggestions', accepted)).status).toBe('accepted');
    expect(await repository.expireSuggestions()).toBe(0);
  });

  it('walks stalled attention behind a durable cursor so unstamped tasks cannot starve later ones', async () => {
    const task = async (minutesAgo: number, patch: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await put('tasks', {
        id,
        agentId,
        status: 'needs_attention',
        attentionNotifiedAt: null,
        updatedAt: ago(minutesAgo * 60_000),
        ...patch,
      });
      return id;
    };
    const first = await task(30);
    const second = await task(20);
    const third = await task(10, { status: 'waiting_event' });
    await task(40, { attentionNotifiedAt: ago(DAY) });
    await task(2);
    await task(50, { agentId: randomUUID() });

    const page = async () =>
      (await repository.listStalledAttention({ olderThanMinutes: 5, batch: 2 })).map((t) => t.id);
    expect(await page()).toEqual([first, second]);
    // Nothing was stamped, yet the next pass reaches the third task.
    expect(await page()).toEqual([third]);
    expect(await page()).toEqual([first, second]);
  });

  it('posts attention notices to the task thread or Notifications, never nowhere', async () => {
    const conversationId = randomUUID();
    await put('conversations', {
      id: conversationId,
      agentId,
      channel: 'email',
      trust: 'owner',
      title: null,
      isPrimary: false,
      archivedAt: null,
      updatedAt: ago(DAY),
    });
    const withThread = randomUUID();
    const assistant = randomUUID();
    const orphan = randomUUID();
    await put('tasks', { id: withThread, agentId, conversationId, trust: 'owner' });
    await put('tasks', { id: assistant, agentId, conversationId: null, trust: 'assistant' });
    await put('tasks', { id: orphan, agentId, conversationId: null, trust: 'owner' });
    const parts = [
      { type: 'text', text: 'needs you' },
      { type: 'notice', notice: 'needs-attention' },
    ];

    for (const taskId of [withThread, assistant])
      expect(await repository.postAttentionNotice({ taskId, text: 'needs you', parts })).toBe(true);
    expect(await repository.postAttentionNotice({ taskId: orphan, text: 'x', parts })).toBe(false);

    const messages = (await store.collection('messages').get()).docs.map((doc) =>
      decodeRecord<Record<string, unknown>>(doc.data()),
    );
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.taskId === withThread)).toMatchObject({
      conversationId,
      role: 'assistant',
      parts,
    });
    const notifications = await store
      .collection('conversations')
      .where('title', '==', 'Notifications')
      .get();
    expect(notifications.size).toBe(1);
    expect(messages.find((m) => m.taskId === assistant)?.conversationId).toBe(
      notifications.docs[0]?.get('id'),
    );
    expect((await read('conversations', conversationId)).updatedAt).toEqual(now);
  });

  it('posts a budget notice once per key, with the key and message committed together', async () => {
    const input = {
      cacheKey: 'budget-notice:daily:80:2026-09-24',
      pct: 83,
      expiresAt: new Date('2026-09-25T00:00:00.000Z'),
      text: 'Budget: 83% of the daily cap used ($0.83 of $1.00).',
    };
    expect(await repository.postBudgetNotice(input)).toBe(true);
    expect(await repository.postBudgetNotice(input)).toBe(false);
    expect(await read('toolCache', input.cacheKey)).toEqual({
      cacheKey: input.cacheKey,
      toolName: 'budget.notice',
      result: { pct: 83 },
      expiresAt: input.expiresAt,
    });
    const messages = await store.collection('messages').get();
    expect(messages.docs.map((doc) => doc.get('text'))).toEqual([input.text]);
  });

  it('embeds missing or foreign-space message vectors with space metadata and resumes after failure', async () => {
    const conversationId = randomUUID();
    const message = async (patch: Record<string, unknown>) => {
      const id = randomUUID();
      await put('messages', {
        id,
        conversationId,
        role: 'user',
        text: 'a message that is long enough to embed',
        embedding: null,
        createdAt: ago(10 * 60_000),
        ...patch,
      });
      return id;
    };
    const eligible = await message({});
    const short = await message({ text: 'x'.repeat(20) });
    // Twenty-one characters but more UTF-16 code units: still eligible.
    const emoji = await message({ text: '😀'.repeat(21), role: 'assistant' });
    const tool = await message({ role: 'tool' });
    const current = await message({});
    const visualFixture = await message({ channelMessageId: 'visual-qa:maintenance:fixture' });
    const readabilityFixture = await message({
      channelMessageId: 'readability-maintenance-run-01-user',
    });
    await store.doc('messages', current).update({
      embedding: FieldValue.vector(vector(1)),
      embeddingSpace: embeddingSpaceKey(space),
    });
    const foreign = await message({});
    await store.doc('messages', foreign).update({
      embedding: FieldValue.vector(vector(2)),
      embeddingSpace: 'another-space',
    });
    await message({ createdAt: ago(10_000) });

    const embed = vi.fn(async (texts: string[]) => texts.map((_, i) => vector(10 + i)));
    expect(
      await repository.embedMissingMessages({
        batch: 20,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed,
      }),
    ).toBe(2);
    expect(embed).toHaveBeenCalledOnce();
    for (const id of [eligible, emoji]) {
      const row = (await store.doc('messages', id).get()).data();
      expect(row?.embeddingSpace).toBe(embeddingSpaceKey(space));
      expect(row?.embedding.toArray()).toHaveLength(1536);
    }
    expect((await store.doc('messages', foreign).get()).get('embeddingSpace')).toBe(
      'another-space',
    );
    for (const id of [short, tool])
      expect((await store.doc('messages', id).get()).get('embedding')).toBeNull();
    expect((await store.doc('messages', visualFixture).get()).get('embedding')).toBeNull();
    expect((await store.doc('messages', readabilityFixture).get()).get('embedding')).toBeNull();

    // A failed embedding call leaves the cursor, so the message is retried.
    now = new Date(now.getTime() + 5 * 60_000);
    const late = await message({ createdAt: ago(2 * 60_000) });
    await expect(
      repository.embedMissingMessages({
        batch: 20,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed: async () => {
          throw new Error('provider down');
        },
      }),
    ).rejects.toThrow('provider down');
    const retry = vi.fn(async (texts: string[]) => texts.map(() => vector(5)));
    // The too-recent message from before has settled and is taken with the late one.
    expect(
      await repository.embedMissingMessages({
        batch: 20,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed: retry,
      }),
    ).toBe(2);
    expect((await store.doc('messages', late).get()).get('embeddingSpace')).toBe(
      embeddingSpaceKey(space),
    );
    const idle = vi.fn(async () => []);
    expect(
      await repository.embedMissingMessages({
        batch: 20,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed: idle,
      }),
    ).toBe(0);
    expect(idle).not.toHaveBeenCalled();

    // A vector outside the configured space is never written.
    await message({ createdAt: ago(61_000) });
    await expect(
      repository.embedMissingMessages({
        batch: 1,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed: async () => [[1, 2, 3]],
      }),
    ).rejects.toThrow('incompatible embedding space');
  });

  it('restarts completed scans to find older backfills and gives each embedding space its own progress', async () => {
    const conversationId = randomUUID();
    const longText = 'an old imported message that needs a semantic vector';
    const add = async (createdAt: Date, text = longText) => {
      const id = randomUUID();
      await put('messages', {
        id,
        conversationId,
        role: 'user',
        text,
        embedding: null,
        createdAt,
      });
      return id;
    };
    const first = await add(ago(30 * 60_000));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector(3)));
    expect(
      await repository.embedMissingMessages({
        batch: 1,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed,
      }),
    ).toBe(1);

    // A late imported record sorts before the completed cursor. A completed
    // sweep must eventually revisit it, while the existing vector is not paid
    // for again.
    const backfilled = await add(ago(60 * 60_000));
    // The in-progress pass reaches end-of-scan and clears its cursor first.
    expect(
      await repository.embedMissingMessages({
        batch: 1,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed,
      }),
    ).toBe(0);
    expect(
      await repository.embedMissingMessages({
        batch: 1,
        embeddingSpaceKey: embeddingSpaceKey(space),
        embed,
      }),
    ).toBe(1);
    expect(embed).toHaveBeenCalledTimes(2);
    expect((await store.doc('messages', backfilled).get()).get('embeddingSpace')).toBe(
      embeddingSpaceKey(space),
    );
    expect((await store.doc('messages', first).get()).get('embeddingSpace')).toBe(
      embeddingSpaceKey(space),
    );

    const nextSpace = { ...space, revision: '2' };
    const nextRepository = new FirestoreMaintenanceRepository(store, agentId, nextSpace);
    const changedSpaceEmbed = vi.fn(async (texts: string[]) => texts.map(() => vector(4)));
    // A new space starts an independent scan but does not pay to regenerate
    // known old vectors automatically.
    expect(
      await nextRepository.embedMissingMessages({
        batch: 10,
        embeddingSpaceKey: embeddingSpaceKey(nextSpace),
        embed: changedSpaceEmbed,
      }),
    ).toBe(0);
    expect(changedSpaceEmbed).not.toHaveBeenCalled();
    for (const id of [first, backfilled])
      expect((await store.doc('messages', id).get()).get('embeddingSpace')).toBe(
        embeddingSpaceKey(space),
      );
  });

  it('purges every expired data class, with memory graph provenance and hash', async () => {
    const hash = 'hash-expired';
    const memory = randomUUID();
    const fresh = randomUUID();
    const permanent = randomUUID();
    await put('memories', {
      id: memory,
      agentId,
      contentHash: hash,
      expiresAt: ago(1),
      embedding: FieldValue.vector(vector(0)),
      embeddingSpaceKey: 'b'.repeat(64),
      embeddingSpace: embeddingSpaceKey(space),
    });
    await store.doc('memoryContentHashes', hash).set({ memoryId: memory });
    await store.doc('knowledgeGraphSources', memory).set({ memoryId: memory, agentId });
    await put('knowledgeGraphRelations', { id: 'relation', agentId, sourceMemoryId: memory });
    await put('knowledgeGraphRelations', { id: 'kept', agentId, sourceMemoryId: fresh });
    await put('memories', { id: fresh, agentId, contentHash: 'f', expiresAt: ago(-DAY) });
    await put('memories', { id: permanent, agentId, contentHash: 'p', expiresAt: null });
    await store.doc('toolCache', 'old').set(encodeRecord({ cacheKey: 'old', expiresAt: now }));
    await store.doc('toolCache', 'new').set(encodeRecord({ cacheKey: 'new', expiresAt: ago(-1) }));
    await put('locationPings', { id: 'old-ping', agentId, capturedAt: ago(31 * DAY) });
    await put('locationPings', { id: 'new-ping', agentId, capturedAt: ago(29 * DAY) });
    await put('dreamNotes', { id: 'old-note', agentId, expiresAt: ago(1) });
    await put('dreamNotes', { id: 'new-note', agentId, expiresAt: ago(-DAY) });
    await put('proactivePings', { id: 'old-nudge', agentId, createdAt: ago(91 * DAY) });
    await put('proactivePings', { id: 'new-nudge', agentId, createdAt: ago(89 * DAY) });
    await put('modelCallAudit', { id: 'old-audit', createdAt: ago(15 * DAY) });
    await put('modelCallAudit', { id: 'new-audit', createdAt: ago(13 * DAY) });

    expect(
      await repository.purgeExpired({
        batch: 500,
        locationRetentionDays: 30,
        proactivePingRetentionDays: 90,
        auditRetentionDays: 14,
      }),
    ).toEqual({
      cache: 1,
      memories: 1,
      locations: 1,
      dreamNotes: 1,
      proactivePings: 1,
      modelCallAudit: 1,
    });
    for (const [collection, id] of [
      ['memories', memory],
      ['memoryContentHashes', hash],
      ['knowledgeGraphSources', memory],
      ['knowledgeGraphRelations', 'relation'],
      ['toolCache', 'old'],
      ['locationPings', 'old-ping'],
      ['dreamNotes', 'old-note'],
      ['proactivePings', 'old-nudge'],
      ['modelCallAudit', 'old-audit'],
    ] as const)
      expect(await exists(collection, id)).toBe(false);
    for (const [collection, id] of [
      ['memories', fresh],
      ['memories', permanent],
      ['knowledgeGraphRelations', 'kept'],
      ['toolCache', 'new'],
      ['locationPings', 'new-ping'],
      ['dreamNotes', 'new-note'],
      ['proactivePings', 'new-nudge'],
      ['modelCallAudit', 'new-audit'],
    ] as const)
      expect(await exists(collection, id)).toBe(true);
  });

  it('purges aged history with PostgreSQL’s exclusions and cascades', async () => {
    const aged = ago(31 * DAY);
    const recent = ago(DAY);
    const conversationId = randomUUID();
    const message = async (createdAt: Date, patch: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await put('messages', { id, conversationId, createdAt, channelMessageId: null, ...patch });
      return id;
    };
    const anchorStart = await message(ago(33 * DAY));
    const anchorEnd = await message(ago(32 * DAY));
    const plain = await message(aged, { channelMessageId: 'sms-1' });
    const kept = await message(recent);
    await store.doc('messageChannelIds', 'sms-1').set({ messageId: plain, conversationId });
    await put('conversationSegments', {
      id: randomUUID(),
      startMessageId: anchorStart,
      endMessageId: anchorEnd,
    });
    await put('generatedCards', { id: 'card', messageId: plain });
    await put('commitments', { id: 'commitment', sourceMessageId: plain });
    await put('recallFeedback', { id: 'feedback', messageId: plain });

    const receiptTaskId = randomUUID();
    await put('tasks', { id: receiptTaskId, agentId, status: 'done', updatedAt: aged, state: {} });
    const toolCall = async (createdAt: Date, patch: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await put('toolCalls', {
        id,
        taskId: receiptTaskId,
        createdAt,
        idempotencyKey: null,
        status: 'succeeded',
        toolName: 'test.retained-effect',
        result: { completed: true },
        error: null,
        decision: {},
        ...patch,
      });
      return id;
    };
    const approved = await toolCall(aged);
    const costed = await toolCall(aged);
    const freedByCost = await toolCall(aged);
    const loose = await toolCall(aged, { idempotencyKey: 'key-1' });
    const newCall = await toolCall(recent);
    await store.doc('toolCallIdempotency', 'key-1').set({ toolCallId: loose });
    await put('approvals', { id: randomUUID(), toolCallId: approved });
    await put('costEvents', { id: 'kept-cost', toolCallId: costed, createdAt: ago(10 * DAY) });
    await put('costEvents', { id: 'aged-cost', toolCallId: freedByCost, createdAt: aged });
    await put('modelCalls', { id: 'old-call', createdAt: aged });
    await put('modelCalls', { id: 'new-call', createdAt: recent });
    await put('modelCallAudit', { id: 'audit', modelCallId: 'old-call', createdAt: recent });

    expect(
      await repository.purgeAgedHistory({ historyDays: 30, costDays: 30, batch: 1000 }),
    ).toEqual({ messages: 1, toolCalls: 2, modelCalls: 1, costEvents: 1 });
    for (const id of [anchorStart, anchorEnd, kept])
      expect(await exists('messages', id)).toBe(true);
    expect(await exists('messages', plain)).toBe(false);
    expect(await exists('messageChannelIds', 'sms-1')).toBe(false);
    expect(await exists('recallFeedback', 'feedback')).toBe(false);
    expect((await read('generatedCards', 'card')).messageId).toBeNull();
    expect((await read('commitments', 'commitment')).sourceMessageId).toBeNull();
    for (const id of [approved, costed, newCall]) expect(await exists('toolCalls', id)).toBe(true);
    for (const id of [freedByCost, loose]) expect(await exists('toolCalls', id)).toBe(false);
    for (const id of [freedByCost, loose]) {
      const receipt = await read('toolCallReceipts', id);
      expect(receipt).toMatchObject({
        id,
        toolCallId: id,
        taskId: receiptTaskId,
        effectOutcome: 'completed',
      });
      expect(receipt).not.toHaveProperty('args');
      expect(receipt).not.toHaveProperty('result');
      expect(receipt).not.toHaveProperty('error');
    }
    expect(await exists('toolCallIdempotency', 'key-1')).toBe(false);
    expect(await exists('modelCalls', 'old-call')).toBe(false);
    expect(await exists('modelCallAudit', 'audit')).toBe(false);
    expect(await exists('modelCalls', 'new-call')).toBe(true);
    expect(await exists('costEvents', 'kept-cost')).toBe(true);
  });

  it('reclaims aged receipts after an old terminal task tree settles', async () => {
    const aged = ago(31 * DAY);
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    await put('tasks', { id: rootId, agentId, status: 'done', updatedAt: aged, state: {} });
    await put('tasks', {
      id: childId,
      agentId,
      parentTaskId: rootId,
      status: 'failed',
      updatedAt: aged,
      state: {},
    });
    await put('tasks', {
      id: grandchildId,
      agentId,
      parentTaskId: childId,
      status: 'cancelled',
      updatedAt: aged,
      state: {},
    });
    const receiptId = randomUUID();
    await put('toolCalls', {
      id: receiptId,
      taskId: rootId,
      createdAt: aged,
      idempotencyKey: null,
      status: 'succeeded',
      toolName: 'test.retained-effect',
      result: { completed: true },
      error: null,
      decision: {},
    });

    expect(
      await repository.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 1000 }),
    ).toMatchObject({ toolCalls: 1 });
    expect(await exists('toolCalls', receiptId)).toBe(false);
    expect(await read('toolCallReceipts', receiptId)).toMatchObject({
      id: receiptId,
      taskId: rootId,
      effectOutcome: 'completed',
    });

    for (const childStatus of ['running', 'done'] as const) {
      const guardedRootId = randomUUID();
      const guardedChildId = randomUUID();
      const recentOrActive = childStatus === 'running' ? aged : now;
      await put('tasks', {
        id: guardedRootId,
        agentId,
        status: 'done',
        updatedAt: aged,
        state: {},
      });
      await put('tasks', {
        id: guardedChildId,
        agentId,
        parentTaskId: guardedRootId,
        status: childStatus,
        updatedAt: recentOrActive,
        state: {},
      });
      const guardedReceiptId = randomUUID();
      await put('toolCalls', {
        id: guardedReceiptId,
        taskId: guardedRootId,
        createdAt: aged,
        idempotencyKey: null,
        status: 'succeeded',
        toolName: 'test.retained-effect',
        result: { completed: true },
        error: null,
        decision: {},
      });

      await repository.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 1000 });
      expect(await exists('toolCalls', guardedReceiptId)).toBe(true);
      expect(await exists('toolCallReceipts', guardedReceiptId)).toBe(false);
    }
  });

  it('retains a full aged call when its compact replay-key projection conflicts', async () => {
    const aged = ago(31 * DAY);
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const modelToolCallId = `conflict-${randomUUID()}`;
    await put('tasks', { id: taskId, agentId, status: 'done', updatedAt: aged, state: {} });
    await put('toolCalls', {
      id: toolCallId,
      taskId,
      createdAt: aged,
      status: 'failed',
      toolName: 'test.compaction-conflict',
      args: { private: 'retain this full row on collision' },
      result: null,
      error: 'synthetic failure',
      decision: { modelToolCallId },
      idempotencyKey: null,
    });
    const [expectedKey] =
      toolCallReplayKeysForStart({
        agentId,
        taskId,
        toolCallId,
        modelToolCallId,
      }) ?? [];
    if (!expectedKey) throw new Error('expected replay key was not generated');
    await put('toolCallReceiptKeys', { ...expectedKey, receiptId: randomUUID() });

    const counts = await repository.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 50 });
    expect(counts.toolCalls).toBe(0);
    expect(await exists('toolCalls', toolCallId)).toBe(true);
    expect(await exists('toolCallReceipts', toolCallId)).toBe(false);
  });

  it('does not invent compact outcomes for missing or nonterminal call status', async () => {
    const aged = ago(31 * DAY);
    const taskId = randomUUID();
    await put('tasks', { id: taskId, agentId, status: 'done', updatedAt: aged, state: {} });
    const missingStatusId = randomUUID();
    const runningId = randomUUID();
    await put('toolCalls', {
      id: missingStatusId,
      taskId,
      createdAt: aged,
      idempotencyKey: null,
      toolName: 'test.unknown-status',
      decision: {},
    });
    await put('toolCalls', {
      id: runningId,
      taskId,
      createdAt: aged,
      idempotencyKey: null,
      status: 'running',
      toolName: 'test.active-call',
      result: null,
      error: null,
      decision: {},
    });

    expect(
      await repository.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 100 }),
    ).toMatchObject({ toolCalls: 0 });
    for (const id of [missingStatusId, runningId]) {
      expect(await exists('toolCalls', id)).toBe(true);
      expect(await exists('toolCallReceipts', id)).toBe(false);
    }
  });

  it('retains terminal receipts named by unresolved or malformed checkpoints', async () => {
    const aged = ago(31 * DAY);
    const fixtures = [
      {
        name: 'pending job',
        state: (callId: string) => ({ pendingJob: { dbToolCallId: callId } }),
      },
      {
        name: 'unsettled tool batch',
        state: (callId: string) => ({
          pendingToolBatch: { calls: [{ status: 'job', dbToolCallId: callId }] },
        }),
      },
      { name: 'malformed state', state: (_callId: string) => 'not-a-checkpoint' },
    ] as const;
    const retained: string[] = [];
    for (const fixture of fixtures) {
      const taskId = randomUUID();
      await put('tasks', {
        id: taskId,
        agentId,
        status: 'done',
        updatedAt: aged,
        state: {},
      });
      const id = randomUUID();
      retained.push(id);
      await put('toolCalls', {
        id,
        taskId,
        createdAt: aged,
        idempotencyKey: null,
        status: 'succeeded',
        toolName: 'test.retained-effect',
        result: { completed: true },
        error: null,
        decision: {},
      });
      const state = fixture.state(id);
      await store.doc('tasks', taskId).update({ state });
    }

    const finalTaskId = randomUUID();
    await put('tasks', {
      id: finalTaskId,
      agentId,
      status: 'done',
      updatedAt: aged,
      state: {
        pendingFinal: {
          text: 'The completed response remains available.',
          progress: 'done',
          terminalStatus: 'done',
          outcome: 'done',
        },
      },
    });
    const finalReceiptId = randomUUID();
    await put('toolCalls', {
      id: finalReceiptId,
      taskId: finalTaskId,
      createdAt: aged,
      idempotencyKey: null,
      status: 'succeeded',
      toolName: 'test.retained-effect',
      result: { completed: true },
      error: null,
      decision: {},
    });
    const danglingTaskId = randomUUID();
    const missingCallId = randomUUID();
    await put('tasks', {
      id: danglingTaskId,
      agentId,
      status: 'done',
      updatedAt: aged,
      state: {
        pendingJob: {
          dbToolCallId: missingCallId,
          toolCallId: 'missing-model-call',
          toolName: 'browser.execute',
          callbackTokenHash: 'c'.repeat(64),
          timeoutAt: now.toISOString(),
        },
      },
    });
    const unrelatedReceiptId = randomUUID();
    await put('toolCalls', {
      id: unrelatedReceiptId,
      taskId: danglingTaskId,
      createdAt: aged,
      idempotencyKey: null,
      status: 'succeeded',
      toolName: 'test.retained-effect',
      result: { completed: true },
      error: null,
      decision: {},
    });

    const counts = await repository.purgeAgedHistory({
      historyDays: 30,
      costDays: 0,
      batch: 1000,
    });
    expect(counts.toolCalls).toBe(2);
    for (const id of retained) {
      expect(await exists('toolCalls', id)).toBe(true);
      expect(await exists('toolCallReceipts', id)).toBe(false);
    }
    expect(await exists('toolCalls', finalReceiptId)).toBe(false);
    expect(await read('toolCallReceipts', finalReceiptId)).toMatchObject({
      id: finalReceiptId,
      taskId: finalTaskId,
      effectOutcome: 'completed',
    });
    expect(await exists('toolCalls', unrelatedReceiptId)).toBe(false);
    expect(await exists('toolCallReceipts', unrelatedReceiptId)).toBe(true);
    expect(await exists('toolCalls', missingCallId)).toBe(false);
    expect(await read('tasks', danglingTaskId)).toMatchObject({
      state: { pendingJob: { dbToolCallId: missingCallId } },
    });
  });

  it('keeps anchored history behind its cursor so it cannot starve later rows', async () => {
    const conversationId = randomUUID();
    const ids = await Promise.all(
      [35, 34, 33].map(async (days) => {
        const id = randomUUID();
        await put('messages', { id, conversationId, createdAt: ago(days * DAY) });
        return id;
      }),
    );
    const [first, second, third] = ids as [string, string, string];
    await put('conversationSegments', {
      id: randomUUID(),
      startMessageId: first,
      endMessageId: second,
    });
    const purge = () => repository.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 1 });

    expect((await purge()).messages).toBe(0);
    expect((await purge()).messages).toBe(0);
    expect((await purge()).messages).toBe(1);
    expect(await exists('messages', third)).toBe(false);

    // The segment goes away; a later full rescan removes what it anchored.
    await store
      .collection('conversationSegments')
      .get()
      .then((page) => Promise.all(page.docs.map((doc) => doc.ref.delete())));
    expect((await purge()).messages).toBe(0);
    now = new Date(now.getTime() + DAY);
    expect((await purge()).messages).toBe(1);
    expect((await purge()).messages).toBe(1);
    expect(await exists('messages', first)).toBe(false);
    expect(await exists('messages', second)).toBe(false);
  });
});
