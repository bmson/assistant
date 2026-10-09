import { randomUUID } from 'node:crypto';
import { chatAdmissionCancellationPayload, chatAdmissionPayload } from '@assistant/persistence';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore application chat persistence',
  () => {
    let store: InstallationStore;
    let repository: FirestoreApplicationChatPersistence;
    const agentId = randomUUID();
    let clock = Date.parse('2026-09-12T12:00:00.000Z');

    beforeEach(async () => {
      store = emulatorStore(() => {
        clock += 1000;
        return new Date(clock);
      });
      repository = new FirestoreApplicationChatPersistence(store);
      const createdAt = new Date(clock);
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Assistant',
        timezone: 'UTC',
        createdAt,
        updatedAt: createdAt,
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    it('refuses a second owner even when the requested owner ID is configured', async () => {
      const foreign = randomUUID();
      await store.doc('agents', foreign).set({ id: foreign, createdAt: new Date(clock) });
      await expect(
        new FirestoreApplicationChatPersistence(store, agentId).resolveAgent(),
      ).rejects.toThrow('exactly one owner');
      await expect(repository.resolveAgent()).rejects.toThrow('exactly one owner');
      await store.doc('agents', foreign).delete();
      await expect(
        new FirestoreApplicationChatPersistence(store, foreign).resolveAgent(),
      ).rejects.toThrow('exactly one owner');
      await expect(repository.resolveAgent()).resolves.toMatchObject({ id: agentId });
    });

    it('enforces ownership and preserves idempotent message delivery', async () => {
      const conversation = await repository.createConversation(agentId);
      await expect(repository.getConversation(randomUUID(), conversation.id)).resolves.toBeNull();
      await expect(
        repository.appendOwned(randomUUID(), {
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'private',
        }),
      ).rejects.toThrow('chat not found');

      const input = {
        conversationId: conversation.id,
        role: 'user' as const,
        origin: 'owner' as const,
        parts: [{ type: 'text', text: 'hello' }],
        text: 'hello',
        channelMessageId: `chat-test:${randomUUID()}`,
      };
      await expect(repository.appendOwned(agentId, input)).resolves.toMatchObject({
        text: 'hello',
      });
      await expect(repository.appendOwned(agentId, input)).resolves.toBeUndefined();
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toHaveLength(1);
    });

    it('atomically deduplicates chat operation admissions and preserves distinct identical sends', async () => {
      const conversation = await repository.createConversation(agentId);
      const operationId = randomUUID();
      const input = {
        agentId,
        conversationId: conversation.id,
        clientOperationId: operationId,
        requestHash: 'b'.repeat(64),
        text: 'Remind me to call Sam tomorrow.',
        autonomous: false,
        force: false,
        spoken: false,
      };
      const [first, concurrent] = await Promise.all([
        repository.admitChatTurn(input),
        repository.admitChatTurn(input),
      ]);
      expect([first.created, concurrent.created].sort()).toEqual([false, true]);
      if (first.kind !== 'admitted' || concurrent.kind !== 'admitted')
        throw new Error('expected normal chat admission results');
      expect(first.task.id).toBe(concurrent.task.id);
      expect(first.message.id).toBe(concurrent.message.id);
      expect(first.lease ?? concurrent.lease).toBeDefined();
      expect(first.message.taskId).toBe(first.task.id);
      await expect(
        repository.admitChatTurn({
          ...input,
          text: 'Send an email to Sam.',
          requestHash: 'c'.repeat(64),
        }),
      ).rejects.toThrow('already used for a different request');

      const second = await repository.admitChatTurn({
        ...input,
        clientOperationId: randomUUID(),
      });
      if (second.kind !== 'admitted') throw new Error('expected a normal chat admission result');
      expect(second.created).toBe(true);
      expect(second.task.id).not.toBe(first.task.id);
      expect(second.task.trigger).toMatchObject({
        payload: { triggerMessageId: second.message.id, text: input.text },
      });
      expect(first.task.trigger).toMatchObject({
        payload: { triggerMessageId: first.message.id, text: input.text },
      });
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toHaveLength(2);
      const directLease = second.lease;
      if (!directLease) throw new Error('newly admitted task did not return its lease');
      await expect(
        repository.markChatTurnStreaming({
          agentId,
          task: directLease,
          triageOutcome: 'conversational',
        }),
      ).resolves.toBe(true);
      const directTask = await store.doc('tasks', second.task.id).get();
      expect(chatAdmissionPayload(directTask.data() as { trigger: unknown })).toMatchObject({
        phase: 'streaming',
        triageOutcome: 'conversational',
      });

      const lease = first.lease ?? concurrent.lease;
      if (!lease) throw new Error('newly admitted task did not return its lease');
      const queued = await repository.queueAdmittedChatTurn({
        agentId,
        task: lease,
        triagedActionable: true,
      });
      expect(queued).toMatchObject({ id: first.task.id, queueGeneration: 1 });
      const queuedTask = await store.doc('tasks', first.task.id).get();
      const queuedRecord = queuedTask.data() as { trigger: unknown };
      expect(chatAdmissionPayload(queuedRecord)).toMatchObject({ phase: 'queued' });
      expect(queuedRecord.trigger).toMatchObject({ payload: { triagedActionable: true } });
      await expect(
        repository.queueAdmittedChatTurn({ agentId, task: lease, triagedActionable: true }),
      ).resolves.toBeNull();
    });

    it('durably cancels before admission and replays without creating owner content', async () => {
      const conversation = await repository.createConversation(agentId);
      const clientOperationId = randomUUID();
      await expect(
        repository.cancelChatTurn({
          agentId,
          conversationId: conversation.id,
          clientOperationId: 'not-a-uuid',
        }),
      ).rejects.toThrow('Invalid chat admission operation identity');
      const input = {
        agentId,
        conversationId: conversation.id,
        clientOperationId,
        requestHash: 'e'.repeat(64),
        text: 'Send a private message that must never be admitted.',
        autonomous: false,
        force: false,
        spoken: false,
      };
      const first = await repository.cancelChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId,
      });
      expect(first).toMatchObject({
        kind: 'cancelled_before_admission',
        status: 'cancelled',
        transitioned: true,
        effectStatus: 'not_started',
      });
      expect(first.task).toMatchObject({
        status: 'cancelled',
        title: null,
        plan: null,
        state: {},
        queueGeneration: 0,
        spentUsd: '0.000000',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        trust: 'owner',
      });
      expect(chatAdmissionCancellationPayload(first.task)).toMatchObject({ clientOperationId });
      await expect(
        repository.getTaskStatus(agentId, conversation.id, first.task.id),
      ).resolves.toBeNull();
      await expect(
        repository.listTaskActivity(agentId, conversation.id, first.task.id),
      ).resolves.toEqual([]);
      expect(first.task.trigger).not.toHaveProperty('payload.text');
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toEqual([]);
      const outbox = await store.db.collection('outbox').where('taskId', '==', first.task.id).get();
      expect(outbox.docs).toHaveLength(0);

      const replay = await repository.admitChatTurn(input);
      expect(replay).toMatchObject({
        kind: 'cancelled_before_admission',
        created: false,
        status: 'cancelled',
        effectStatus: 'not_started',
      });
      expect(replay.task.id).toBe(first.task.id);
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toEqual([]);
      await expect(
        repository.cancelChatTurn({ agentId, conversationId: conversation.id, clientOperationId }),
      ).resolves.toMatchObject({
        kind: 'cancelled_before_admission',
        transitioned: false,
        effectStatus: 'not_started',
      });
    });

    it('fails closed when an operation index points to a task at a different identity', async () => {
      const conversation = await repository.createConversation(agentId);
      const clientOperationId = randomUUID();
      const marker = await repository.cancelChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId,
      });
      if (marker.kind !== 'cancelled_before_admission')
        throw new Error('expected a cancellation marker');
      await store.doc('tasks', marker.task.id).update({ id: randomUUID() });

      await expect(
        repository.cancelChatTurn({ agentId, conversationId: conversation.id, clientOperationId }),
      ).rejects.toThrow('Chat admission index points to a mismatched task');
      await expect(
        repository.admitChatTurn({
          agentId,
          conversationId: conversation.id,
          clientOperationId,
          requestHash: 'e'.repeat(64),
          text: 'must not be admitted',
          autonomous: false,
          force: false,
          spoken: false,
        }),
      ).rejects.toThrow('Chat admission index points to a mismatched task');
    });

    it('linearizes a concurrent stop against admission without ghosting owner text', async () => {
      const conversation = await repository.createConversation(agentId);

      const clientOperationId = randomUUID();
      const input = {
        agentId: agentId,
        conversationId: conversation.id,
        clientOperationId,
        requestHash: '9'.repeat(64),
        text: 'This text must either be admitted once or remain absent.',
        autonomous: false,
        force: false,
        spoken: false,
      };
      const [stopped, admitted] = await Promise.all([
        repository.cancelChatTurn({
          agentId: agentId,
          conversationId: conversation.id,
          clientOperationId,
        }),
        repository.admitChatTurn(input),
      ]);
      if (admitted.kind === 'cancelled_before_admission') {
        expect(stopped).toMatchObject({
          kind: 'cancelled_before_admission',
          effectStatus: 'not_started',
        });
        expect(stopped.task.id).toBe(admitted.task.id);
        expect((await repository.listMessages(agentId, conversation.id))?.messages).toEqual([]);
      } else {
        expect(stopped).toMatchObject({
          kind: 'admitted_task',
          status: 'cancelled',
          effectStatus: 'unknown',
        });
        expect(stopped.task.id).toBe(admitted.task.id);
        expect(
          (await repository.listMessages(agentId, conversation.id))?.messages.map(
            (message) => message.text,
          ),
        ).toEqual([input.text]);
      }
      const stored = await store.doc('tasks', stopped.task.id).get();
      expect(stored.data()).toMatchObject({
        status: 'cancelled',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        queueGeneration: 0,
      });
      const outbox = await store.db
        .collection('outbox')
        .where('taskId', '==', stopped.task.id)
        .get();
      expect(outbox.docs).toHaveLength(0);
    });

    it('cancels an admitted task conservatively and preserves already-terminal tasks', async () => {
      const conversation = await repository.createConversation(agentId);
      const activeOperationId = randomUUID();
      const active = await repository.admitChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId: activeOperationId,
        requestHash: 'f'.repeat(64),
        text: 'Start work.',
        autonomous: false,
        force: false,
        spoken: false,
      });
      if (active.kind !== 'admitted') throw new Error('expected a normal chat admission result');
      const stopped = await repository.cancelChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId: activeOperationId,
      });
      expect(stopped).toMatchObject({
        kind: 'admitted_task',
        status: 'cancelled',
        transitioned: true,
        effectStatus: 'unknown',
      });
      expect(stopped.task.id).toBe(active.task.id);

      const terminalOperationId = randomUUID();
      const terminal = await repository.admitChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId: terminalOperationId,
        requestHash: '1'.repeat(64),
        text: 'Already completed work.',
        autonomous: false,
        force: false,
        spoken: false,
      });
      if (terminal.kind !== 'admitted') throw new Error('expected a normal chat admission result');
      await store
        .doc('tasks', terminal.task.id)
        .update({ status: 'done', leaseToken: null, lockedUntil: null });
      await expect(
        repository.cancelChatTurn({
          agentId,
          conversationId: conversation.id,
          clientOperationId: terminalOperationId,
        }),
      ).resolves.toMatchObject({
        kind: 'admitted_task',
        status: 'done',
        transitioned: false,
        effectStatus: 'unknown',
      });
    });

    it('accepts an idempotent client delivery receipt only for the completed matching owner turn', async () => {
      const conversation = await repository.createConversation(agentId);
      const clientId = randomUUID();
      const admission = await repository.admitChatTurn({
        agentId,
        conversationId: conversation.id,
        clientOperationId: randomUUID(),
        clientId,
        requestHash: 'd'.repeat(64),
        text: 'What time is it?',
        autonomous: false,
        force: false,
        spoken: false,
      });
      if (admission.kind !== 'admitted') throw new Error('expected a normal chat admission result');
      expect(admission.lease).toBeDefined();
      if (!admission.lease) throw new Error('chat admission did not return a lease');
      await expect(
        repository.acknowledgeMessageDelivery(agentId, conversation.id, randomUUID(), clientId),
      ).resolves.toBe(false);
      await repository.completeDirectChatTask({
        agentId,
        task: admission.lease,
        status: 'done',
        messages: [
          {
            conversationId: conversation.id,
            taskId: admission.task.id,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: 'It is noon.' }],
            text: 'It is noon.',
          },
        ],
      });
      const page = await repository.listMessages(agentId, conversation.id);
      const reply = page?.messages.find((message) => message.role === 'assistant');
      if (!reply) throw new Error('completed turn did not persist its reply');
      await expect(
        repository.acknowledgeMessageDelivery(agentId, conversation.id, reply.id, randomUUID()),
      ).resolves.toBe(false);
      await expect(
        repository.acknowledgeMessageDelivery(agentId, conversation.id, reply.id, clientId),
      ).resolves.toBe(true);
      await expect(
        repository.acknowledgeMessageDelivery(agentId, conversation.id, reply.id, clientId),
      ).resolves.toBe(true);
      await expect(
        repository.acknowledgeMessageDelivery(agentId, conversation.id, reply.id, randomUUID()),
      ).resolves.toBe(false);
    });

    it('returns one primary conversation to concurrent bootstrap callers', async () => {
      const [first, second] = await Promise.all([
        repository.getOrCreatePrimaryConversation(agentId),
        repository.getOrCreatePrimaryConversation(agentId),
      ]);
      const third = await repository.getOrCreatePrimaryConversation(agentId);

      expect(first.isPrimary).toBe(true);
      expect(first.archivedAt).toBeNull();
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(
        (await store.collection('conversations').where('isPrimary', '==', true).get()).size,
      ).toBe(1);
      expect((await store.doc('primaryConversations', agentId).get()).get('conversationId')).toBe(
        first.id,
      );
    });

    it('uses bounded keyset pages for conversation and message lists', async () => {
      const first = await repository.createConversation(agentId);
      const second = await repository.createConversation(agentId);
      const conversations = await repository.listConversations(agentId, {
        archived: false,
        limit: 1,
      });
      expect(conversations.conversations.map((row) => row.id)).toEqual([second.id]);
      expect(conversations.hasMore).toBe(true);
      expect(conversations.nextCursor).not.toBeNull();

      for (const text of ['one', 'two', 'three']) {
        await repository.appendOwned(agentId, {
          conversationId: first.id,
          role: 'user',
          origin: 'owner',
          parts: [{ type: 'text', text }],
          text,
        });
      }
      const tail = await repository.listMessages(agentId, first.id, { limit: 2 });
      expect(tail?.messages.map((row) => row.text)).toEqual(['two', 'three']);
      const cursor = tail?.messages[0];
      expect(cursor).toBeDefined();
      const next = await repository.listMessages(agentId, first.id, {
        limit: 1,
        after: cursor,
      });
      expect(next?.messages.map((row) => row.text)).toEqual(['three']);
      expect(next?.hasMore).toBe(false);
    });

    it('bounds an imported history to the latest default page', async () => {
      const conversation = await repository.createConversation(agentId);
      const batch = store.db.batch();
      const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
      for (let index = 0; index < 250; index += 1) {
        const id = randomUUID();
        batch.set(store.doc('messages', id), {
          id,
          conversationId: conversation.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          origin: index % 2 === 0 ? 'owner' : 'assistant',
          parts: [{ type: 'text', text: `imported-${index}` }],
          text: `imported-${index}`,
          taskId: null,
          channelMessageId: null,
          hiddenAt: null,
          createdAt: new Date(baseTime + index * 1_000),
        });
      }
      await batch.commit();

      const page = await repository.listMessages(agentId, conversation.id);

      expect(page?.messages).toHaveLength(100);
      expect(page?.messages[0]?.text).toBe('imported-150');
      expect(page?.messages.at(-1)?.text).toBe('imported-249');
    });

    it('keeps native timestamp precision in message cursors', async () => {
      const conversation = await repository.createConversation(agentId);
      const firstId = randomUUID();
      const secondId = randomUUID();
      const seconds = Date.parse('2026-09-12T12:00:00Z') / 1_000;
      await Promise.all([
        store.doc('messages', firstId).set({
          id: firstId,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'first',
          hiddenAt: null,
          createdAt: new Timestamp(seconds, 123_456_000),
          appendedAt: new Timestamp(seconds, 123_456_000),
        }),
        store.doc('messages', secondId).set({
          id: secondId,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'second',
          hiddenAt: null,
          createdAt: new Timestamp(seconds, 123_789_000),
          appendedAt: new Timestamp(seconds, 123_789_000),
        }),
      ]);

      const firstPage = await repository.listMessages(agentId, conversation.id, { limit: 1 });
      expect(firstPage?.messages[0]).toMatchObject({
        id: secondId,
        createdAtExact: '2026-09-12T12:00:00.123789000Z',
      });

      const afterFirst = await repository.listMessages(agentId, conversation.id, {
        limit: 1,
        after: {
          createdAt: new Date('2026-09-12T12:00:00.123Z'),
          createdAtExact: '2026-09-12T12:00:00.123456Z',
          id: firstId,
          appendSequence: (BigInt(seconds) * 1_000_000_000n + 123_456_000n)
            .toString()
            .padStart(20, '0'),
        },
      });
      expect(afterFirst?.messages.map((message) => message.id)).toEqual([secondId]);
    });

    it('delivers an old-createdAt message that commits after a full append backlog', async () => {
      const conversation = await repository.createConversation(agentId);
      const firstSequence = '00000000000000000000';
      let beginDelayed!: () => void;
      let releaseDelayed!: () => void;
      const started = new Promise<void>((resolve) => (beginDelayed = resolve));
      const gate = new Promise<void>((resolve) => (releaseDelayed = resolve));
      const delayedId = randomUUID();
      const delayed = store.db.runTransaction(async (tx) => {
        tx.create(store.doc('messages', delayedId), {
          id: delayedId,
          conversationId: conversation.id,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: 'delayed' }],
          text: 'delayed',
          hiddenAt: null,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          appendedAt: FieldValue.serverTimestamp(),
        });
        beginDelayed();
        await gate;
      });
      await started;

      const backlog = [];
      for (let index = 0; index < 5; index += 1) {
        backlog.push(
          await repository.appendOwned(agentId, {
            conversationId: conversation.id,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: `backlog ${index.toString()}` }],
            text: `backlog ${index.toString()}`,
          }),
        );
      }
      const delivered: string[] = [];
      let cursor = {
        createdAt: new Date(0),
        appendSequence: firstSequence,
        id: '00000000-0000-0000-0000-000000000000',
      };
      let page = await repository.listMessages(agentId, conversation.id, {
        after: cursor,
        limit: 2,
      });
      while (page?.hasMore) {
        delivered.push(...page.messages.map((message) => message.id));
        const last = page.messages.at(-1);
        if (last?.appendSequence)
          cursor = { createdAt: last.createdAt, appendSequence: last.appendSequence, id: last.id };
        page = await repository.listMessages(agentId, conversation.id, { after: cursor, limit: 2 });
      }
      delivered.push(...(page?.messages.map((message) => message.id) ?? []));
      const last = page?.messages.at(-1);
      if (last?.appendSequence)
        cursor = { createdAt: last.createdAt, appendSequence: last.appendSequence, id: last.id };
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(delivered).toEqual(backlog.map((message) => message?.id));

      releaseDelayed();
      await delayed;
      const afterCommit = await repository.listMessages(agentId, conversation.id, {
        after: cursor,
        limit: 2,
      });
      expect(afterCommit?.messages.map((message) => message.id)).toEqual([delayedId]);
      const replay = await repository.listMessages(agentId, conversation.id, {
        after: {
          createdAt: new Date(0),
          appendSequence: afterCommit?.messages[0]?.appendSequence,
          id: delayedId,
        },
        limit: 2,
      });
      expect(replay?.messages).toEqual([]);
    });

    it('hides and restores only messages in an owned conversation', async () => {
      const conversation = await repository.createConversation(agentId);
      const message = await repository.appendOwned(agentId, {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: 'private detail' }],
        text: 'private detail',
      });
      expect(message).toBeDefined();
      if (!message) throw new Error('message was not persisted');
      await expect(
        repository.setMessageHidden(randomUUID(), conversation.id, message.id, true),
      ).resolves.toBe(false);
      await expect(
        repository.setMessageHidden(agentId, conversation.id, message.id, true),
      ).resolves.toBe(true);
      await expect(repository.listMessages(agentId, conversation.id)).resolves.toMatchObject({
        messages: [],
      });
      await expect(
        repository.setMessageHidden(agentId, conversation.id, message.id, false),
      ).resolves.toBe(true);
      await expect(repository.listMessages(agentId, conversation.id)).resolves.toMatchObject({
        messages: [{ id: message.id }],
      });
    });

    it('checks active work transactionally before archiving', async () => {
      const conversation = await repository.createConversation(agentId);
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        conversationId: conversation.id,
        status: 'pending',
        type: 'adhoc',
      });
      await expect(repository.archiveConversation(agentId, conversation.id)).resolves.toBe(
        'active',
      );
      await store.doc('tasks', taskId).update({ status: 'done' });
      await expect(repository.archiveConversation(agentId, conversation.id)).resolves.toBe(
        'archived',
      );
      expect(
        (await repository.getConversation(agentId, conversation.id))?.archivedAt,
      ).toBeInstanceOf(Date);
      await expect(repository.countConversations(agentId, true)).resolves.toBe(1);
      await expect(
        repository.listConversations(agentId, { archived: true }),
      ).resolves.toMatchObject({
        conversations: [{ id: conversation.id }],
      });
    });

    it('atomically completes a leased direct task and fences stale retries', async () => {
      const conversation = await repository.createConversation(agentId);
      await store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '1.2500' });
      const task = await repository.createDirectChatTask({
        agentId,
        conversationId: conversation.id,
        title: 'Direct reply',
      });
      expect(task).toMatchObject({
        status: 'running',
        conversationId: conversation.id,
        budgetUsdLimit: '1.2500',
      });

      const completed = await repository.completeDirectChatTask({
        agentId,
        task,
        status: 'done',
        progress: 'Completed',
        messages: [
          {
            conversationId: conversation.id,
            taskId: task.id,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: 'Finished' }],
            text: 'Finished',
          },
        ],
      });
      expect(completed).toBe(true);
      await expect(
        repository.completeDirectChatTask({
          agentId,
          task,
          status: 'done',
          messages: [],
        }),
      ).resolves.toBe(false);
      await expect(repository.getTaskStatus(agentId, conversation.id, task.id)).resolves.toBe(
        'done',
      );
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toMatchObject([
        { taskId: task.id, text: 'Finished' },
      ]);
    });

    it('deduplicates approvals requested directly and through their task', async () => {
      const taskId = randomUUID();
      const approvalId = randomUUID();
      const toolCallId = `call/${randomUUID()}`;
      await store
        .doc('toolCalls', toolCallId)
        .set({ id: toolCallId, taskId, toolName: 'gmail.send' });
      await store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'waiting_approval' });
      await store.doc('approvals', approvalId).set({
        id: approvalId,
        taskId,
        toolCallId,
        summary: 'Synthetic approval',
        status: 'pending',
        payload: {},
        expiresAt: new Date(clock + 60_000),
      });

      const hydrated = await repository.getHydrationState(agentId, {
        approvalIds: [approvalId],
        approvalTaskIds: [taskId],
        budgetTaskIds: [],
        suggestionIds: [],
      });
      expect(hydrated.approvals.map((approval) => approval.id)).toEqual([approvalId]);
      expect(hydrated.taskApprovals.map((approval) => approval.id)).toEqual([approvalId]);
      expect(hydrated.approvals[0]?.toolName).toBe('gmail.send');
      expect(hydrated.taskApprovals[0]?.toolName).toBe('gmail.send');
      await store.doc('toolCalls', toolCallId).update({ taskId: 'foreign-task' });
      const foreign = await repository.getHydrationState(agentId, {
        approvalIds: [approvalId],
        approvalTaskIds: [taskId],
        budgetTaskIds: [],
        suggestionIds: [],
      });
      expect(foreign.approvals[0]?.toolName).toBeUndefined();
    });

    it('fails explicitly when task approval hydration exceeds its bound', async () => {
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'waiting_approval' });
      const batch = store.db.batch();
      for (let index = 0; index <= 200; index += 1) {
        const approvalId = randomUUID();
        batch.set(store.doc('approvals', approvalId), {
          id: approvalId,
          taskId,
          summary: `Synthetic approval ${index}`,
          status: 'pending',
          payload: {},
          expiresAt: new Date(clock + 60_000),
        });
      }
      await batch.commit();

      await expect(
        repository.getHydrationState(agentId, {
          approvalIds: [],
          approvalTaskIds: [taskId],
          budgetTaskIds: [],
          suggestionIds: [],
        }),
      ).rejects.toThrow('Approval hydration exceeds bounded page size');
    });
  },
);
