import { createHash, randomUUID } from 'node:crypto';
import { cardFormAdmissionActiveEventId } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { prepareOwnerCardFormTurn } from '../../application/src/card-form-admission.js';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { FirestoreCardFormAdmissionRepository } from './card-form-admission.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore card form admission', () => {
  it('atomically commits message, pending chat task, operation key, and wake; exact replay survives card advance', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    try {
      const now = new Date();
      await store
        .doc('agents', agentId)
        .set({ id: agentId, name: 'Test owner', createdAt: now, updatedAt: now });
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        isPrimary: false,
        archivedAt: null,
        updatedAt: now,
      });
      const form = {
        type: 'form',
        id: 'meeting',
        title: 'Meeting details',
        serverAction: 'submit_owner_chat_turn',
        submitLabel: 'Continue',
        warningFactIds: [],
        fields: [
          { id: 'date', type: 'date', label: 'Date', required: true, sensitive: false },
          { id: 'attendees', type: 'text', label: 'Attendees', required: false, sensitive: false },
        ],
      };
      const spec = {
        version: 1,
        title: 'Calendar request',
        accessibilityLabel: 'Calendar request',
        facts: [
          { id: 'private', value: 'owner-secret-token', source: 'private source', sensitive: true },
        ],
        blocks: [form],
        actions: [],
        sourceLabel: 'owner request',
      };
      await store
        .doc('generatedCardRevisions', revisionId)
        .set({ id: revisionId, cardId, version: 1, spec });
      await store.doc('generatedCardRevisions', nextRevisionId).set({
        id: nextRevisionId,
        cardId,
        version: 2,
        spec: {
          ...spec,
          title: 'Changed card',
          blocks: [form, { ...form, title: 'Duplicate form ID' }],
        },
      });
      await store.doc('generatedCards', cardId).set({
        id: cardId,
        agentId,
        conversationId,
        status: 'active',
        currentRevisionId: revisionId,
        expiresAt: null,
        dismissedAt: null,
        updatedAt: now,
      });
      await store.doc('budgets', 'task_default').set({ limitUsd: '0.50' });
      const repository = new FirestoreCardFormAdmissionRepository(store, agentId);
      const chat = new FirestoreApplicationChatPersistence(store, agentId);
      const submission = {
        protocol: 'card-form-v1',
        conversationId,
        cardId,
        expectedRevisionId: revisionId,
        formId: 'meeting',
        operationId,
        values: { date: '2026-10-10', attendees: 'Sam' },
        ownerMessageText: 'Please check whether 2026-10-10 works for the meeting.',
      };
      const otherConversationId = randomUUID();
      await store.doc('conversations', otherConversationId).set({
        id: otherConversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        isPrimary: false,
        archivedAt: null,
        updatedAt: now,
      });
      const wrongConversation = await repository.submit({
        agentId,
        submission: {
          ...submission,
          conversationId: otherConversationId,
          operationId: randomUUID(),
        },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(wrongConversation).toMatchObject({ ok: false, status: 404 });
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('conversationId', '==', otherConversationId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', otherConversationId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      const rejectedSecret = await repository.submit({
        agentId,
        submission: {
          ...submission,
          operationId: randomUUID(),
          values: { ...submission.values, attendees: 'owner-secret-token' },
        },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(rejectedSecret).toMatchObject({ ok: false, status: 422 });
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        repository.submit({ agentId, submission, prepare: prepareOwnerCardFormTurn }),
      ).rejects.toThrow('Privacy erasure is in progress');
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .get()
          .then((s) => s.size),
      ).toBe(0);
      await store.doc('privacyErasureJobs', agentId).delete();
      const [first, concurrent] = await Promise.all([
        repository.submit({ agentId, submission, prepare: prepareOwnerCardFormTurn }),
        repository.submit({ agentId, submission, prepare: prepareOwnerCardFormTurn }),
      ]);
      expect(new Set([first, concurrent].flatMap((r) => (r.ok ? [r.taskId] : []))).size).toBe(1);
      const created = [first, concurrent].find((r) => r.ok && r.created);
      if (!created?.ok) throw new Error('form admission was not created');
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      expect(
        await store
          .collection('outbox')
          .where('taskId', '==', created.taskId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      const taskDoc = await store.doc('tasks', created.taskId).get();
      expect(taskDoc.get('title')).toBe('Owner form request');
      const taskPayload = taskDoc.get('trigger.payload') as Record<string, unknown>;
      expect(taskPayload.text).toBe('Please check whether 2026-10-10 works for the meeting.');
      const formReceipt = taskPayload.cardFormAdmission;
      expect(formReceipt).toMatchObject({
        protocol: 'card-form-v1',
        cardId,
        expectedRevisionId: revisionId,
        formId: 'meeting',
        operationId,
      });
      expect(JSON.stringify(formReceipt)).not.toContain('Sam');
      expect(JSON.stringify(formReceipt)).not.toContain('owner-secret-token');
      const nextSubmission = { ...submission, operationId: randomUUID() };
      const activeEventId = cardFormAdmissionActiveEventId({ agentId, cardId, formId: 'meeting' });
      const activeRef = store.doc(
        'taskEventKeys',
        createHash('sha256').update(activeEventId).digest('hex'),
      );
      const activeReceipt = (await activeRef.get()).data();
      if (!activeReceipt) throw new Error('active form key was not committed');
      await activeRef.update({ taskId: 'missing-active-form-task' });
      await expect(
        repository.submit({
          agentId,
          submission: nextSubmission,
          prepare: prepareOwnerCardFormTurn,
        }),
      ).rejects.toThrow('Card form active-operation index points to a missing task');
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      await activeRef.set(activeReceipt);
      const whileActive = await repository.submit({
        agentId,
        submission: nextSubmission,
        prepare: prepareOwnerCardFormTurn,
      });
      expect(whileActive).toMatchObject({
        ok: false,
        status: 409,
        reason: 'active_form',
        activeTaskId: created.taskId,
        taskStatus: 'pending',
      });
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      expect(
        await store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      await store.doc('tasks', created.taskId).update({ trust: 'known' });
      await expect(
        repository.submit({
          agentId,
          submission: nextSubmission,
          prepare: prepareOwnerCardFormTurn,
        }),
      ).rejects.toThrow('Card form active-operation identity collision');
      await store.doc('tasks', created.taskId).update({ trust: 'owner' });
      await store.doc('tasks', created.taskId).update({ status: 'needs_attention' });
      expect(
        await repository.submit({
          agentId,
          submission: nextSubmission,
          prepare: prepareOwnerCardFormTurn,
        }),
      ).toMatchObject({ ok: false, status: 409 });
      await store.doc('tasks', created.taskId).update({ status: 'failed' });
      const secondOperation = await repository.submit({
        agentId,
        submission: nextSubmission,
        prepare: prepareOwnerCardFormTurn,
      });
      expect(secondOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
      if (!secondOperation.ok) throw new Error('second intentional operation failed');
      expect(secondOperation.taskId).not.toBe(created.taskId);
      expect(
        (await store.doc('tasks', secondOperation.taskId).get()).get('trigger.payload.text'),
      ).toBe(submission.ownerMessageText);
      expect(
        (
          await store.collection('messages').where('taskId', '==', secondOperation.taskId).get()
        ).docs[0]?.get('text'),
      ).toBe(submission.ownerMessageText);
      expect(
        await store
          .collection('outbox')
          .where('taskId', '==', secondOperation.taskId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(2);
      const thirdSubmission = { ...submission, operationId: randomUUID() };
      expect(
        await repository.submit({
          agentId,
          submission: thirdSubmission,
          prepare: prepareOwnerCardFormTurn,
        }),
      ).toMatchObject({ ok: false, status: 409 });
      await store.doc('tasks', secondOperation.taskId).update({ status: 'cancelled' });
      const thirdOperation = await repository.submit({
        agentId,
        submission: thirdSubmission,
        prepare: prepareOwnerCardFormTurn,
      });
      expect(thirdOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
      if (!thirdOperation.ok) throw new Error('third intentional operation failed');
      expect(thirdOperation.taskId).not.toBe(secondOperation.taskId);
      expect(
        await store
          .collection('outbox')
          .where('taskId', '==', thirdOperation.taskId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
      await store.doc('tasks', thirdOperation.taskId).update({ status: 'done' });
      const fourthSubmission = { ...submission, operationId: randomUUID() };
      const distinctOperations = await Promise.all([
        repository.submit({
          agentId,
          submission: fourthSubmission,
          prepare: prepareOwnerCardFormTurn,
        }),
        repository.submit({
          agentId,
          submission: { ...submission, operationId: randomUUID() },
          prepare: prepareOwnerCardFormTurn,
        }),
      ]);
      expect(distinctOperations.filter((result) => result.ok && result.created)).toHaveLength(1);
      expect(
        distinctOperations.filter((result) => !result.ok && result.status === 409),
      ).toHaveLength(1);
      const fourthOperation = distinctOperations.find((result) => result.ok && result.created);
      if (!fourthOperation)
        throw new Error('Concurrent device submissions did not produce one admission');
      expect(fourthOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
      if (!fourthOperation.ok) throw new Error('fourth intentional operation failed');
      await store.doc('tasks', fourthOperation.taskId).update({ status: 'done' });
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(4);
      const projected = await chat.listMessages(agentId, conversationId, { fromStart: true });
      const admittedMessages =
        projected?.messages.filter((message) =>
          [
            created.taskId,
            secondOperation.taskId,
            thirdOperation.taskId,
            fourthOperation.taskId,
          ].includes(message.taskId ?? ''),
        ) ?? [];
      expect(admittedMessages).toHaveLength(4);
      expect(admittedMessages.map((message) => message.text)).toEqual(
        Array(4).fill(submission.ownerMessageText),
      );
      expect(
        admittedMessages.every(
          (message) =>
            typeof message.appendSequence === 'string' &&
            message.appendSequence !== '00000000000000000000',
        ),
      ).toBe(true);
      await store.doc('generatedCards', cardId).update({ currentRevisionId: nextRevisionId });
      const taskRef = store.doc('tasks', created.taskId);
      const originalTrigger = (await taskRef.get()).get('trigger');
      if (!originalTrigger || typeof originalTrigger !== 'object')
        throw new Error('form task trigger is missing');
      await taskRef.update({ 'trigger.payload.text': 'tampered trigger text' });
      expect(
        await repository.submit({ agentId, submission, prepare: prepareOwnerCardFormTurn }),
      ).toMatchObject({ ok: false, status: 409 });
      await taskRef.update({ trigger: originalTrigger });
      const messageRef = store.doc('messages', created.messageId);
      await messageRef.update({ text: 'tampered owner message' });
      expect(
        await repository.submit({ agentId, submission, prepare: prepareOwnerCardFormTurn }),
      ).toMatchObject({ ok: false, status: 409 });
      await messageRef.update({ text: submission.ownerMessageText });
      const replay = await repository.submit({
        agentId,
        submission,
        prepare: prepareOwnerCardFormTurn,
      });
      expect(replay).toMatchObject({
        ok: true,
        created: false,
        taskId: created.taskId,
        messageId: created.messageId,
      });
      const conflict = await repository.submit({
        agentId,
        submission: { ...submission, values: { ...submission.values, attendees: 'Alex' } },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(conflict).toMatchObject({ ok: false, status: 409 });
      expect(conflict).not.toHaveProperty('reason', 'stale_revision');
      const editedTextConflict = await repository.submit({
        agentId,
        submission: { ...submission, ownerMessageText: 'Please schedule another date.' },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(editedTextConflict).toMatchObject({ ok: false, status: 409 });
      expect(editedTextConflict).not.toHaveProperty('reason', 'stale_revision');
      const staleNewOperation = await repository.submit({
        agentId,
        submission: { ...submission, operationId: randomUUID() },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(staleNewOperation).toMatchObject({ ok: false, status: 409, reason: 'stale_revision' });
      const ambiguousForm = await repository.submit({
        agentId,
        submission: {
          ...submission,
          expectedRevisionId: nextRevisionId,
          operationId: randomUUID(),
        },
        prepare: prepareOwnerCardFormTurn,
      });
      expect(ambiguousForm).toMatchObject({ ok: false, status: 422 });
      expect(
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .get()
          .then((s) => s.size),
      ).toBe(4);
      expect(
        await store
          .collection('outbox')
          .where('taskId', '==', created.taskId)
          .get()
          .then((s) => s.size),
      ).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });
});
