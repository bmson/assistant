import { randomUUID } from 'node:crypto';
import { buildRequestChecklist } from '@assistant/core/workflow/request-checklist';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
} from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { wakeIntentId } from './outbox.js';
import type { InstallationStore } from './store.js';
import { FirestoreTaskActivityCommandRepository } from './task-activity-commands.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore Activity retry and cancel commands',
  () => {
    let store: InstallationStore;
    let repository: FirestoreTaskActivityCommandRepository;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const retryId = randomUUID();
    const runningId = randomUUID();
    const markerId = randomUUID();

    beforeEach(async () => {
      store = emulatorStore();
      repository = new FirestoreTaskActivityCommandRepository(store);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('tasks', retryId).set({
        ...taskFixture({
          id: retryId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
        queueGeneration: 5,
        attempt: 3,
        state: { checkpoint: 'resume', pendingFinal: { text: 'already delivered' } },
      });
      await store.doc('tasks', runningId).set({
        ...taskFixture({
          id: runningId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'running',
        progress: 'attempt 1 failed: AI_APICallError https://provider.example/private',
        lockedUntil: new Date(Date.now() + 60_000),
        leaseToken: randomUUID(),
      });
      await store.doc('tasks', 'foreign').set({
        ...taskFixture({
          id: 'foreign',
          agentId: foreignAgentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
      });
    });

    async function seedCancellationMarker() {
      const markerConversationId = randomUUID();
      const markerOperationId = randomUUID();
      await store.doc('tasks', markerId).set({
        ...taskFixture({
          id: markerId,
          agentId,
          conversationId: markerConversationId,
          reminderId: '',
        }),
        type: 'chat_turn',
        status: 'cancelled',
        title: null,
        progress: '',
        trust: 'owner',
        spentUsd: '0.000000',
        budgetUsdLimit: '0.5000',
        archivedAt: null,
        autonomyGrant: null,
        trigger: chatAdmissionCancellationTrigger({
          agentId,
          conversationId: markerConversationId,
          clientOperationId: markerOperationId,
        }),
        externalEventId: chatAdmissionExternalEventId({
          agentId,
          conversationId: markerConversationId,
          clientOperationId: markerOperationId,
        }),
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      });
    }

    afterEach(async () => {
      await disposeStore(store);
    });

    async function seedCorrectionTask(input: {
      taskId: string;
      conversationId: string;
      checklist: NonNullable<ReturnType<typeof buildRequestChecklist>>;
      queueGeneration?: number;
      state?: Record<string, unknown>;
      plan?: unknown;
      type?: string;
      trust?: string;
      goalId?: string | null;
      omitOriginalMessage?: boolean;
      trigger?: (
        messageId: string,
        agentId: string,
        conversationId: string,
        request: string,
      ) => unknown;
    }): Promise<string> {
      const originalMessageId = randomUUID();
      const request = input.checklist.request;
      const trigger = input.trigger
        ? input.trigger(originalMessageId, agentId, input.conversationId, request)
        : {
            source: 'chat',
            agentId,
            conversationId: input.conversationId,
            trust: 'owner',
            payload: { text: request, triggerMessageId: originalMessageId },
          };
      await store.doc('conversations', input.conversationId).set({
        id: input.conversationId,
        agentId,
        channel: 'chat',
      });
      await store.doc('tasks', input.taskId).set({
        ...taskFixture({
          id: input.taskId,
          agentId,
          conversationId: input.conversationId,
          reminderId: '',
        }),
        type: input.type ?? 'chat_turn',
        trust: input.trust ?? 'owner',
        goalId: input.goalId ?? null,
        trigger,
        status: 'needs_attention',
        queueGeneration: input.queueGeneration ?? 4,
        leaseToken: null,
        lockedUntil: null,
        archivedAt: null,
        state: input.state ?? { requestChecklist: input.checklist },
        plan: input.plan ?? null,
      });
      if (!input.omitOriginalMessage)
        await store.doc('messages', originalMessageId).set({
          id: originalMessageId,
          taskId: input.taskId,
          conversationId: input.conversationId,
          role: 'user',
          origin: 'owner',
          text: request,
          parts: [{ type: 'text', text: request }],
          createdAt: store.now(),
          appendSequence: '00000000000000000000',
        });
      return originalMessageId;
    }

    it('retries once, reports the winning generation, and commits one matching wake intent', async () => {
      const results = await Promise.all([
        repository.retry(agentId, retryId),
        repository.retry(agentId, retryId),
      ]);
      expect(results.map((row) => row.outcome).sort()).toEqual(['no_longer_retriable', 'retried']);
      expect(results.filter((row) => row.transitioned)).toHaveLength(1);
      expect(results.find((row) => row.transitioned)).toMatchObject({
        outcome: 'retried',
        current: { status: 'pending', queueGeneration: 6 },
      });
      const task = await store.doc('tasks', retryId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('queueGeneration')).toBe(6);
      expect(task.get('attempt')).toBe(0);
      expect(task.get('state')).toEqual({ checkpoint: 'resume' });
      const intents = await store.collection('outbox').get();
      expect(intents.size).toBe(1);
      expect(intents.docs[0]?.get('taskId')).toBe(retryId);
      expect(intents.docs[0]?.get('generation')).toBe(6);
    });

    it('atomically revises one explicitly selected pending item and deduplicates its owner message', async () => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const ownerMessageId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
      });
      const chat = new FirestoreApplicationChatPersistence(store);
      const priorMessage = await chat.appendOwned(agentId, {
        conversationId,
        taskId,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: checklist.request }],
        text: checklist.request,
      });
      if (!priorMessage) throw new Error('test cursor message was not persisted');
      const priorPlan = { steps: [{ description: 'Search for the hotel' }] };
      const priorState = {
        requestChecklist: checklist,
        plannerState: { ownerIntent: 'hotel' },
        clarificationContinuation: { sourceTaskId: 'prior', answerStatus: 'uncertain' },
        pendingFinal: { text: 'stale final' },
        completedToolCallIds: ['done-call'],
        triggerMessageId: priorMessage.id,
      };
      await store.doc('tasks', taskId).set({
        ...taskFixture({ id: taskId, agentId, conversationId, reminderId: '' }),
        type: 'chat_turn',
        status: 'needs_attention',
        queueGeneration: 4,
        attempt: 2,
        leaseToken: null,
        lockedUntil: null,
        archivedAt: null,
        state: priorState,
        plan: priorPlan,
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: checklist.request, triggerMessageId: priorMessage.id },
        },
      });
      const input = {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId,
        replacementKind: 'lookup' as const,
        replacementLabel: 'Find my flight to Berlin',
      };
      const [first, replay] = await Promise.all([
        repository.revisePendingChecklist(agentId, input),
        repository.revisePendingChecklist(agentId, input),
      ]);
      expect([first.outcome, replay.outcome].sort()).toEqual(['already_applied', 'corrected']);
      expect([first, replay].filter((row) => row.transitioned)).toHaveLength(1);
      await expect(
        repository.revisePendingChecklist(agentId, {
          ...input,
          replacementKind: 'reminder',
        }),
      ).resolves.toMatchObject({ outcome: 'invalid' });
      await expect(
        repository.revisePendingChecklist(agentId, { ...input, expectedRevision: 1 }),
      ).resolves.toMatchObject({ outcome: 'invalid' });
      const task = await store.doc('tasks', taskId).get();
      expect(task.data()).toMatchObject({ status: 'pending', queueGeneration: 5, plan: null });
      expect(task.get('state')).toMatchObject({
        plannerState: priorState.plannerState,
        clarificationContinuation: priorState.clarificationContinuation,
        completedToolCallIds: priorState.completedToolCallIds,
        triggerMessageId: priorState.triggerMessageId,
        requestChecklist: {
          request: 'Find my hotel and remind me about the hotel',
          revision: 1,
        },
      });
      expect(task.get('state')).not.toHaveProperty('pendingFinal');
      const persistedState = task.get('state') as {
        requestChecklist?: { items?: Array<{ label: string }> };
      };
      expect(persistedState.requestChecklist?.items?.map((item) => item.label)).toContain(
        'Find my flight to Berlin',
      );
      expect((await store.doc('messages', ownerMessageId).get()).data()).toMatchObject({
        id: ownerMessageId,
        taskId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Find my flight to Berlin',
      });
      expect(
        (await store.collection('outbox').where('taskId', '==', taskId).get()).docs,
      ).toHaveLength(1);
      const afterCursor = await chat.listMessages(agentId, conversationId, {
        after: {
          id: priorMessage.id,
          createdAt: priorMessage.createdAt,
          appendSequence: priorMessage.appendSequence,
        },
        limit: 2,
      });
      expect(afterCursor?.messages.map((message) => message.id)).toContain(ownerMessageId);
      await expect(repository.revisePendingChecklist(agentId, input)).resolves.toMatchObject({
        outcome: 'already_applied',
        transitioned: false,
        queueGeneration: 5,
      });
    });

    it.each([
      ['pending batch', { pendingToolBatch: { calls: [{ toolCallId: 'queued-not-ledgered' }] } }],
      ['pending job', { pendingJob: { dbToolCallId: 'queued-not-ledgered' } }],
    ])('refuses a %s journal and leaves task/message/wake untouched', async (_name, journal) => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      const priorPlan = { steps: [{ description: 'Search for the hotel' }] };
      await seedCorrectionTask({
        taskId,
        conversationId,
        checklist,
        state: { requestChecklist: checklist, ...journal },
        plan: priorPlan,
      });
      await expect(
        repository.revisePendingChecklist(agentId, {
          taskId,
          itemId: checklist.items[0]?.id ?? '',
          expectedRevision: 0,
          ownerMessageId: randomUUID(),
          replacementKind: 'lookup',
          replacementLabel: 'Find my flight to Berlin',
        }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence', transitioned: false });
      const task = await store.doc('tasks', taskId).get();
      expect(task.data()).toMatchObject({
        status: 'needs_attention',
        queueGeneration: 4,
        plan: priorPlan,
      });
      expect((task.get('state') as Record<string, unknown>).requestChecklist).toEqual(checklist);
      expect((await store.collection('messages').where('taskId', '==', taskId).get()).size).toBe(1);
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(0);
    });

    it.each([
      ['non-owner trust', { trust: 'known' }],
      ['ad hoc task', { type: 'adhoc' }],
      ['scheduled task', { type: 'scheduled' }],
      ['goal task', { goalId: randomUUID() }],
      [
        'forwarded email task',
        {
          type: 'email_triage',
          trust: 'unknown',
          trigger: (
            messageId: string,
            ownerId: string,
            conversationId: string,
            request: string,
          ) => ({
            source: 'email',
            agentId: ownerId,
            conversationId,
            trust: 'unknown',
            payload: { text: request, triggerMessageId: messageId },
          }),
        },
      ],
      [
        'malformed pinned trigger',
        {
          trigger: (
            _messageId: string,
            ownerId: string,
            conversationId: string,
            request: string,
          ) => ({
            source: 'chat',
            agentId: ownerId,
            conversationId,
            trust: 'owner',
            payload: { text: request, triggerMessageId: 'not-a-message-id' },
          }),
        },
      ],
      [
        'trigger text that differs from the checklist request',
        {
          trigger: (
            messageId: string,
            ownerId: string,
            conversationId: string,
            request: string,
          ) => ({
            source: 'chat',
            agentId: ownerId,
            conversationId,
            trust: 'owner',
            payload: { text: `${request} unrelated`, triggerMessageId: messageId },
          }),
        },
      ],
      ['missing durable original message', { omitOriginalMessage: true }],
    ])('refuses correction for %s without task/message/wake writes', async (_name, options) => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      const priorPlan = { steps: [{ description: 'Keep plan for an ineligible task' }] };
      await seedCorrectionTask({ taskId, conversationId, checklist, plan: priorPlan, ...options });
      const correctionMessageId = randomUUID();
      await expect(
        repository.revisePendingChecklist(agentId, {
          taskId,
          itemId: checklist.items[0]?.id ?? '',
          expectedRevision: 0,
          ownerMessageId: correctionMessageId,
          replacementKind: 'lookup',
          replacementLabel: 'Find my flight to Berlin',
        }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence', transitioned: false });
      const task = await store.doc('tasks', taskId).get();
      expect(task.data()).toMatchObject({
        status: 'needs_attention',
        queueGeneration: 4,
        plan: priorPlan,
      });
      expect((task.get('state') as Record<string, unknown>).requestChecklist).toEqual(checklist);
      expect((await store.doc('messages', correctionMessageId).get()).exists).toBe(false);
      expect((await store.collection('messages').where('taskId', '==', taskId).get()).size).toBe(
        'omitOriginalMessage' in options && options.omitOriginalMessage ? 0 : 1,
      );
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(0);
    });

    it('rejects an unknown receipt, approved tool call, and foreign owner without mutation', async () => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      await seedCorrectionTask({ taskId, conversationId, checklist, queueGeneration: 2 });
      const input = {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup' as const,
        replacementLabel: 'Find my flight to Berlin',
      };
      await expect(repository.revisePendingChecklist(foreignAgentId, input)).resolves.toMatchObject(
        {
          outcome: 'not_found',
        },
      );
      const receiptId = randomUUID();
      await store.doc('toolCallReceipts', receiptId).set({
        id: receiptId,
        agentId,
        taskId,
        toolCallId: receiptId,
        toolName: 'calendar.list_events',
        effectOutcome: 'unknown',
      });
      await expect(repository.revisePendingChecklist(agentId, input)).resolves.toMatchObject({
        outcome: 'unsafe_evidence',
      });
      await store.doc('toolCallReceipts', receiptId).delete();
      const foreignReceiptId = randomUUID();
      await store.doc('toolCallReceipts', foreignReceiptId).set({
        id: foreignReceiptId,
        agentId: foreignAgentId,
        taskId,
        toolCallId: foreignReceiptId,
        toolName: 'calendar.list_events',
        effectOutcome: 'completed',
      });
      await expect(
        repository.revisePendingChecklist(agentId, { ...input, ownerMessageId: randomUUID() }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
      await store.doc('toolCallReceipts', foreignReceiptId).delete();
      const callId = randomUUID();
      await store.doc('toolCalls', callId).set({
        id: callId,
        taskId,
        toolName: 'calendar.list_events',
        status: 'approved',
        args: {},
        result: null,
        error: null,
        step: 1,
      });
      await expect(
        repository.revisePendingChecklist(agentId, { ...input, ownerMessageId: randomUUID() }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
      await store.doc('toolCalls', callId).delete();
      const failedCallId = randomUUID();
      await store.doc('toolCalls', failedCallId).set({
        id: failedCallId,
        taskId,
        toolName: 'calendar.list_events',
        status: 'failed',
        args: {},
        result: null,
        error: 'temporary failure after dispatch',
        step: 2,
      });
      await expect(
        repository.revisePendingChecklist(agentId, { ...input, ownerMessageId: randomUUID() }),
      ).resolves.toMatchObject({ outcome: 'invalid' });
      await store.doc('toolCalls', failedCallId).delete();
      await store.doc('approvals', randomUUID()).set({
        taskId,
        status: 'approved',
      });
      await expect(
        repository.revisePendingChecklist(agentId, { ...input, ownerMessageId: randomUUID() }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
      expect((await store.doc('tasks', taskId).get()).get('queueGeneration')).toBe(2);
      expect((await store.collection('messages').where('taskId', '==', taskId).get()).size).toBe(1);
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(0);
    });

    it('fails closed when retained receipt history exceeds the evidence bound', async () => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      await seedCorrectionTask({ taskId, conversationId, checklist, queueGeneration: 3 });
      const batch = store.db.batch();
      for (let index = 0; index < 129; index += 1) {
        const id = randomUUID();
        batch.create(store.doc('toolCallReceipts', id), {
          id,
          agentId,
          taskId,
          toolCallId: id,
          toolName: 'calendar.list_events',
          effectOutcome: 'not_executed',
        });
      }
      await batch.commit();

      await expect(
        repository.revisePendingChecklist(agentId, {
          taskId,
          itemId: checklist.items[0]?.id ?? '',
          expectedRevision: 0,
          ownerMessageId: randomUUID(),
          replacementKind: 'lookup',
          replacementLabel: 'Find my flight to Berlin',
        }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
      expect((await store.doc('tasks', taskId).get()).get('queueGeneration')).toBe(3);
      expect((await store.collection('messages').where('taskId', '==', taskId).get()).size).toBe(1);
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(0);
    });

    it('rolls back the owner message and checklist if the atomic wake intent already exists', async () => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const ownerMessageId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      await seedCorrectionTask({ taskId, conversationId, checklist, queueGeneration: 4 });
      const collisionId = wakeIntentId(taskId, 5);
      await store.doc('outbox', collisionId).set({
        id: collisionId,
        taskId,
        generation: 5,
        status: 'pending',
        attempts: 0,
        leaseToken: null,
        lockedUntil: null,
        createdAt: store.now(),
        availableAt: store.now(),
      });

      await expect(
        repository.revisePendingChecklist(agentId, {
          taskId,
          itemId: checklist.items[0]?.id ?? '',
          expectedRevision: 0,
          ownerMessageId,
          replacementKind: 'lookup',
          replacementLabel: 'Find my flight to Berlin',
        }),
      ).rejects.toThrow();
      expect((await store.doc('tasks', taskId).get()).get('status')).toBe('needs_attention');
      const unchangedState = (await store.doc('tasks', taskId).get()).get('state') as {
        requestChecklist?: unknown;
      };
      expect(unchangedState.requestChecklist).toEqual(checklist);
      expect((await store.doc('messages', ownerMessageId).get()).exists).toBe(false);
      expect((await store.doc('outbox', collisionId).get()).exists).toBe(true);
    });

    it('serializes correction against a concurrent generic retry without losing the original request', async () => {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
      if (!checklist) throw new Error('test checklist is invalid');
      await seedCorrectionTask({ taskId, conversationId, checklist, queueGeneration: 1 });
      const correction = repository.revisePendingChecklist(agentId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      });
      const retry = repository.retry(agentId, taskId);
      const [corrected, retried] = await Promise.all([correction, retry]);
      expect(['corrected', 'no_longer_retriable']).toContain(corrected.outcome);
      expect(['retried', 'no_longer_retriable']).toContain(retried.outcome);
      const task = await store.doc('tasks', taskId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('state')).toMatchObject({
        requestChecklist: { request: 'Find my hotel and remind me about the hotel' },
      });
      if (corrected.outcome === 'corrected') {
        expect(task.get('state')).toMatchObject({ requestChecklist: { revision: 1 } });
        const state = task.get('state') as {
          requestChecklist?: { items?: Array<{ label: string }> };
        };
        expect(state.requestChecklist?.items?.map((item) => item.label)).toContain(
          'Find my flight to Berlin',
        );
      }
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(1);
    });

    it('rejects foreign work and fences retry during privacy erasure', async () => {
      await expect(repository.retry(agentId, 'foreign')).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.retry(agentId, retryId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', retryId).get()).get('status')).toBe('needs_attention');
      expect((await store.collection('outbox').get()).size).toBe(0);
      await store.doc('privacyErasureJobs', agentId).delete();
      await expect(repository.cancel(agentId, 'foreign')).resolves.toMatchObject({
        outcome: 'not_found',
      });
    });

    it('hides cancellation marker task IDs from archive, restore, and archive-old', async () => {
      await seedCancellationMarker();
      await expect(repository.archive(agentId, markerId)).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      await expect(repository.restore(agentId, markerId)).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      const progress = await repository.archiveOld(agentId, 30);
      expect(progress.archivedTotal).toBe(0);
      const marker = await store.doc('tasks', markerId).get();
      expect(marker.get('status')).toBe('cancelled');
      expect(marker.get('archivedAt')).toBeNull();
    });

    it('cancels a running task idempotently and prevents its lease from being claimed', async () => {
      await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
        outcome: 'cancelled',
        transitioned: true,
        current: { status: 'cancelled' },
      });
      await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
        outcome: 'already_cancelled',
        transitioned: false,
        current: { status: 'cancelled' },
      });
      const task = await store.doc('tasks', runningId).get();
      expect(task.get('status')).toBe('cancelled');
      expect(task.get('progress')).toBe('This task was cancelled.');
      expect(task.get('leaseToken')).toBeNull();
      expect(task.get('lockedUntil')).toBeNull();
      expect(await new FirestoreTaskRepository(store).claim(runningId)).toBeNull();
    });

    it('leaves the task unchanged when cancellation races with privacy erasure', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.cancel(agentId, runningId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', runningId).get()).get('status')).toBe('running');
    });

    it.each(['done', 'failed'])(
      'does not turn an already %s result into cancellation',
      async (status) => {
        await store.doc('tasks', runningId).update({ status });
        await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
          outcome: 'already_terminal',
          transitioned: false,
          current: { status },
        });
        expect((await store.doc('tasks', runningId).get()).get('status')).toBe(status);
      },
    );

    it('archives more than 400 rows in durable bounded batches and resumes after a retry', async () => {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      for (let offset = 0; offset < 601; offset += 400) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 400, 601); index += 1) {
          const id = `archive-${String(index).padStart(3, '0')}`;
          batch.set(store.doc('tasks', id), {
            ...taskFixture({
              id,
              agentId,
              conversationId: randomUUID(),
              reminderId: '',
            }),
            status: 'done',
            updatedAt: old,
          });
        }
        await batch.commit();
      }
      await store.doc('tasks', 'still-live').set({
        ...taskFixture({
          id: 'still-live',
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'running',
        updatedAt: old,
      });

      const first = await repository.archiveOld(agentId);
      expect(first).toMatchObject({
        archivedThisBatch: 250,
        archivedTotal: 250,
        scannedThisBatch: 250,
        scannedTotal: 250,
        complete: false,
      });
      expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/i);
      expect((await store.doc('tasks', 'still-live').get()).get('archivedAt')).toBeNull();

      // A restarted caller resumes the durable operation rather than restarting at page one.
      const second = await repository.archiveOld(agentId, 30, first.operationId ?? undefined);
      expect(second).toMatchObject({
        operationId: first.operationId,
        archivedThisBatch: 250,
        archivedTotal: 500,
        scannedTotal: 500,
        complete: false,
      });
      const third = await repository.archiveOld(agentId, 30, first.operationId ?? undefined);
      expect(third).toMatchObject({
        operationId: first.operationId,
        archivedThisBatch: 101,
        archivedTotal: 601,
        scannedTotal: 601,
        complete: true,
      });
      expect(
        (await store.collection('tasks').where('agentId', '==', agentId).get()).docs,
      ).toHaveLength(604);
      const archivedCount = (
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('archivedAt', '!=', null)
          .get()
      ).size;
      expect(archivedCount).toBe(601);

      // Retrying a completed operation reports its stored total without starting another run.
      expect(
        await repository.archiveOld(agentId, 30, first.operationId ?? undefined),
      ).toMatchObject({ archivedTotal: 601, complete: true, scannedThisBatch: 0 });
    });

    it('rechecks ownership and privacy erasure before each continuation batch', async () => {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      for (let index = 0; index < 251; index += 1) {
        const id = `erase-archive-${String(index).padStart(3, '0')}`;
        await store.doc('tasks', id).set({
          ...taskFixture({
            id,
            agentId,
            conversationId: randomUUID(),
            reminderId: '',
          }),
          status: 'done',
          updatedAt: old,
        });
      }
      const first = await repository.archiveOld(agentId);
      expect(first.complete).toBe(false);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        repository.archiveOld(agentId, 30, first.operationId ?? undefined),
      ).rejects.toThrow('Privacy erasure is in progress');
      const unarchived = await store
        .collection('tasks')
        .where('agentId', '==', agentId)
        .where('archivedAt', '==', null)
        .get();
      expect(unarchived.docs.filter((doc) => doc.get('status') === 'done')).toHaveLength(1);
    });
  },
);
