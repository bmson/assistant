import { randomUUID } from 'node:crypto';
import { type Records, securityIncidentId } from '@assistant/persistence';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import type { InstallationStore } from './store.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner dashboard notices', () => {
  let store: InstallationStore;
  let notices: FirestoreOwnerNoticeRepository;
  const agentId = randomUUID();
  const now = new Date('2026-09-23T12:00:00.000Z');
  let clock = now;

  beforeEach(async () => {
    clock = now;
    store = emulatorStore(() => clock);
    notices = new FirestoreOwnerNoticeRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('mirrors into an existing primary chat, but does not duplicate its own notice', async () => {
    const primaryId = randomUUID();
    const taskId = randomUUID();
    await Promise.all([
      store.doc('conversations', primaryId).set({
        id: primaryId,
        agentId,
        channel: 'chat',
        isPrimary: true,
        archivedAt: null,
        title: 'Primary',
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId }),
    ]);
    expect(await notices.primaryConversationId()).toBe(primaryId);
    expect(
      await notices.post({ text: 'Already here', sourceConversationId: primaryId }),
    ).toBeNull();
    expect(
      await notices.post({
        text: 'Approval needed',
        taskId,
        sourceConversationId: randomUUID(),
        extraParts: [{ type: 'approval-summary', approvalCount: 1 }],
      }),
    ).toEqual({ conversationId: primaryId });
    const messages = await store
      .collection('messages')
      .where('conversationId', '==', primaryId)
      .get();
    expect(messages.size).toBe(1);
    expect(messages.docs[0]?.get('taskId')).toBe(taskId);
    expect(messages.docs[0]?.get('parts')).toEqual([
      { type: 'text', text: 'Approval needed' },
      { type: 'approval-summary', approvalCount: 1 },
    ]);
    expect(
      (await store.collection('conversations').where('title', '==', 'Notifications').get()).size,
    ).toBe(0);
  });

  it('uses one assistant-owned Notifications chat before a primary exists', async () => {
    const first = await notices.post({ text: 'Task finished' });
    const second = await notices.post({ text: 'Another task finished' });
    expect(first?.conversationId).toBe(second?.conversationId);
    const chats = await store
      .collection('conversations')
      .where('title', '==', 'Notifications')
      .get();
    expect(chats.size).toBe(1);
    expect(chats.docs[0]?.get('trust')).toBe('assistant');
    expect(chats.docs[0]?.get('isPrimary')).toBe(false);
    expect((await store.collection('messages').get()).size).toBe(2);
  });

  it('reuses a migrated Notifications chat and rejects foreign tasks or active erasure', async () => {
    const legacyId = randomUUID();
    await store.doc('conversations', legacyId).set({
      id: legacyId,
      agentId,
      channel: 'chat',
      isPrimary: false,
      archivedAt: null,
      title: 'Notifications',
    });
    expect(await notices.post({ text: 'Recovered notice' })).toEqual({ conversationId: legacyId });
    expect(
      (await store.doc('notificationConversations', agentId).get()).get('conversationId'),
    ).toBe(legacyId);
    const foreignTaskId = randomUUID();
    await store.doc('tasks', foreignTaskId).set({ id: foreignTaskId, agentId: randomUUID() });
    await expect(notices.post({ text: 'foreign', taskId: foreignTaskId })).rejects.toThrow(
      'outside the configured installation',
    );
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(notices.post({ text: 'blocked' })).rejects.toThrow('Privacy erasure');
    expect((await store.collection('messages').get()).size).toBe(1);
  });

  it('fences dashboard publication against an already-committed source dismissal', async () => {
    const observationFence = await notices.observationFence(agentId);
    const suggestionId = randomUUID();
    const sourceRef = `booking:${randomUUID()}:3:cancel:current`;
    const suggestion: Records['suggestions'] = {
      id: suggestionId,
      agentId,
      conversationId: null,
      summary: 'Cancelled booking',
      proposedAction: 'Review the booking cancellation',
      origin: 'briefing',
      bookingKey: null,
      bookingVersion: null,
      bookingCancellation: null,
      sourceRef,
      status: 'dismissed',
      acceptedTaskId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      snoozedUntil: null,
    };
    await store.doc('suggestions', suggestionId).set(encodeRecord(suggestion));

    const result = await notices.postWithDecisionFence({
      agentId,
      text: 'A cancelled booking needs review',
      now,
      observationFence,
      suggestionSourceRefs: [sourceRef],
      requiredSuggestionSourceRefs: [sourceRef],
      securityIncidents: [],
    });
    expect(result).toEqual({
      status: 'stale',
      inactiveSuggestionSourceRefs: [sourceRef],
      inactiveSecurityIncidents: [],
    });
    expect((await store.collection('messages').get()).size).toBe(0);
    await store.doc('suggestions', suggestionId).delete();
    expect(
      await notices.postWithDecisionFence({
        agentId,
        text: 'A stale source that was removed',
        now,
        observationFence,
        suggestionSourceRefs: [sourceRef],
        requiredSuggestionSourceRefs: [sourceRef],
        securityIncidents: [],
      }),
    ).toMatchObject({
      status: 'stale',
      inactiveSuggestionSourceRefs: [sourceRef],
    });
    expect((await store.collection('messages').get()).size).toBe(0);
  });

  it('publishes before a later dismissal and then refuses the same source on refresh', async () => {
    const observationFence = await notices.observationFence(agentId);
    const suggestionId = randomUUID();
    const sourceRef = `booking:${randomUUID()}:3:cancel:current`;
    const suggestion: Records['suggestions'] = {
      id: suggestionId,
      agentId,
      conversationId: null,
      summary: 'Cancelled booking',
      proposedAction: 'Review the booking cancellation',
      origin: 'briefing',
      bookingKey: null,
      bookingVersion: null,
      bookingCancellation: null,
      sourceRef,
      status: 'pending',
      acceptedTaskId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      snoozedUntil: null,
    };
    await store.doc('suggestions', suggestionId).set(encodeRecord(suggestion));
    const input = {
      agentId,
      text: 'One cancelled booking needs review',
      now,
      observationFence,
      suggestionSourceRefs: [sourceRef],
      requiredSuggestionSourceRefs: [sourceRef],
      securityIncidents: [],
    };
    expect(await notices.postWithDecisionFence(input)).toMatchObject({ status: 'posted' });
    await store.doc('suggestions', suggestionId).update({ status: 'dismissed', updatedAt: now });
    expect(await notices.postWithDecisionFence(input)).toMatchObject({
      status: 'stale',
      inactiveSuggestionSourceRefs: [sourceRef],
    });
    expect((await store.collection('messages').get()).size).toBe(1);
  });

  it('rechecks security decisions and settles the accepted attention receipt with the message', async () => {
    const observationFence = await notices.observationFence(agentId);
    const incidentId = securityIncidentId(agentId, 'incident:notice-fence-test');
    const revision = 2;
    const attentionId = securityIncidentId(agentId, `attention:${incidentId}:${revision}`);
    const incident: Records['securityIncidents'] = {
      id: incidentId,
      agentId,
      incidentKey: 'notice-fence-test',
      confidence: 'provider-reference',
      revision,
      disposition: 'dismissed',
      decisionRevision: revision,
      decisionReason: 'already handled',
      materialChangeReason: null,
      createdAt: now,
      updatedAt: now,
    };
    const attention: Records['securityIncidentAttention'] = {
      id: attentionId,
      agentId,
      incidentId,
      revision,
      producer: 'briefing',
      deliveryStatus: 'claimed',
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      store.doc('securityIncidents', incidentId).set(encodeRecord(incident)),
      store.doc('securityIncidentAttention', attentionId).set(encodeRecord(attention)),
    ]);
    const input = {
      agentId,
      text: 'A security notice needs review',
      now,
      observationFence,
      suggestionSourceRefs: [],
      requiredSuggestionSourceRefs: [],
      securityIncidents: [{ incidentId, revision }],
    };
    expect(await notices.postWithDecisionFence(input)).toMatchObject({
      status: 'stale',
      inactiveSecurityIncidents: [{ incidentId, revision }],
    });
    expect((await store.collection('messages').get()).size).toBe(0);

    await store.doc('securityIncidents', incidentId).update({
      disposition: 'unreviewed',
      decisionRevision: null,
    });
    expect(await notices.postWithDecisionFence(input)).toMatchObject({ status: 'posted' });
    expect(
      (await store.doc('securityIncidentAttention', attentionId).get()).get('deliveryStatus'),
    ).toBe('accepted');
    expect((await store.collection('messages').get()).size).toBe(1);
  });

  it('uses publication time and refuses a required source that expired during drafting', async () => {
    const observationFence = await notices.observationFence(agentId);
    const suggestionId = randomUUID();
    const sourceRef = `booking:${randomUUID()}:3:cancel:expires-during-draft`;
    const suggestion: Records['suggestions'] = {
      id: suggestionId,
      agentId,
      conversationId: null,
      summary: 'Expiring proposal',
      proposedAction: 'Review before the event',
      origin: 'briefing',
      bookingKey: null,
      bookingVersion: null,
      bookingCancellation: null,
      sourceRef,
      status: 'pending',
      acceptedTaskId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      snoozedUntil: null,
    };
    await store.doc('suggestions', suggestionId).set(encodeRecord(suggestion));
    clock = new Date(now.getTime() + 2_000);
    const result = await notices.postWithDecisionFence({
      agentId,
      text: 'An expired proposal',
      now,
      observationFence,
      suggestionSourceRefs: [sourceRef],
      requiredSuggestionSourceRefs: [sourceRef],
      securityIncidents: [],
    });
    expect(result).toMatchObject({
      status: 'stale',
      inactiveSuggestionSourceRefs: [sourceRef],
    });
    expect((await store.collection('messages').get()).size).toBe(0);
  });

  it('samples expiry after a delayed source read and destination lookup', async () => {
    const observationFence = await notices.observationFence(agentId);
    const suggestionId = randomUUID();
    const sourceRef = `booking:${randomUUID()}:3:cancel:delayed-read`;
    await store.doc('suggestions', suggestionId).set(
      encodeRecord({
        id: suggestionId,
        agentId,
        conversationId: null,
        summary: 'Delayed proposal',
        proposedAction: 'Review before the event',
        origin: 'briefing',
        bookingKey: null,
        bookingVersion: null,
        bookingCancellation: null,
        sourceRef,
        status: 'pending',
        acceptedTaskId: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 1_000),
        snoozedUntil: null,
      }),
    );

    let releaseRead!: () => void;
    let markReadPaused!: () => void;
    const pausedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readPaused = new Promise<void>((resolve) => {
      markReadPaused = resolve;
    });
    let paused = false;
    const originalDb = store.db;
    const runTransaction = originalDb.runTransaction.bind(originalDb);
    const delayedDb = new Proxy(originalDb, {
      get(target, property) {
        if (property !== 'runTransaction') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return <T>(updateFunction: (transaction: Transaction) => Promise<T>) =>
          runTransaction(async (transaction) => {
            let readCount = 0;
            const delayedTransaction = new Proxy(transaction, {
              get(targetTransaction, txProperty) {
                if (txProperty !== 'get') return Reflect.get(targetTransaction, txProperty);
                const read = targetTransaction.get.bind(targetTransaction) as (
                  reference: unknown,
                ) => Promise<unknown>;
                return async (reference: unknown) => {
                  const result = await read(reference);
                  readCount += 1;
                  // Owner, generation, erasure timestamp, then the source query.
                  if (!paused && readCount === 4) {
                    paused = true;
                    markReadPaused();
                    await pausedRead;
                  }
                  return result;
                };
              },
            }) as Transaction;
            return updateFunction(delayedTransaction);
          });
      },
    }) as Firestore;
    Object.defineProperty(store, 'db', { value: delayedDb });
    try {
      const resultPromise = notices.postWithDecisionFence({
        agentId,
        text: 'A proposal that expires during the read',
        now,
        observationFence,
        suggestionSourceRefs: [sourceRef],
        requiredSuggestionSourceRefs: [sourceRef],
        securityIncidents: [],
      });
      await readPaused;
      clock = new Date(now.getTime() + 2_000);
      releaseRead();
      expect(await resultPromise).toMatchObject({
        status: 'stale',
        inactiveSuggestionSourceRefs: [sourceRef],
      });
      expect((await store.collection('messages').get()).size).toBe(0);
    } finally {
      Object.defineProperty(store, 'db', { value: originalDb });
    }
  });

  it('rejects a completed privacy generation change after source observation', async () => {
    const observationFence = await notices.observationFence(agentId);
    await store.doc('privacyErasureJobs', agentId).set({
      agentId,
      generation: 'completed-generation-after-observation',
      status: 'complete',
      counts: { memories: 0, graphRelations: 0, writingSamples: 0, securityIncidents: 0 },
      updatedAt: new Date(now.getTime() + 1_000),
    });
    await expect(
      notices.postWithDecisionFence({
        agentId,
        text: 'A pre-erasure briefing draft',
        now,
        observationFence,
        suggestionSourceRefs: [],
        requiredSuggestionSourceRefs: [],
        securityIncidents: [],
      }),
    ).rejects.toThrow('Privacy erasure changed during owner notice composition');
    expect((await store.collection('messages').get()).size).toBe(0);
  });

  it('writes owner.notify into its task chat without opening SQL', async () => {
    const conversationId = randomUUID();
    const taskId = randomUUID();
    await Promise.all([
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        isPrimary: false,
        archivedAt: null,
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId, conversationId }),
    ]);
    expect(await notices.postToolNotice({ text: 'Reminder text', taskId, conversationId })).toEqual(
      {
        conversationId,
      },
    );
    const messages = await store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .get();
    expect(messages.size).toBe(1);
    expect(messages.docs[0]?.data()).toMatchObject({
      taskId,
      role: 'assistant',
      origin: 'assistant',
      text: 'Reminder text',
      parts: [{ type: 'text', text: 'Reminder text' }],
    });
  });

  it('uses Notifications without a task chat and refuses foreign ownership or erasure', async () => {
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({ id: taskId, agentId, conversationId: null });
    const first = await notices.postToolNotice({ text: 'Time to check back', taskId });
    const second = await notices.postToolNotice({ text: 'Another check', taskId });
    expect(first.conversationId).toBe(second.conversationId);
    expect((await store.collection('messages').get()).size).toBe(2);

    const foreignTask = randomUUID();
    await store.doc('tasks', foreignTask).set({ id: foreignTask, agentId: randomUUID() });
    await expect(notices.postToolNotice({ text: 'No', taskId: foreignTask })).rejects.toThrow(
      'outside the configured installation',
    );
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(notices.postToolNotice({ text: 'Blocked', taskId })).rejects.toThrow(
      'Privacy erasure',
    );
    expect((await store.collection('messages').get()).size).toBe(2);
  });
});
