import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreCardRefreshRepository } from './card-refresh.js';
import { disposeStore, emulatorStore } from './test-store.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function deterministicPrimaryId(agentId: string): string {
  const hex = createHash('sha256')
    .update(`assistant:primary-conversation:${agentId}`)
    .digest('hex');
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

describe.skipIf(!enabled)('Firestore saved-card refresh', () => {
  it('deduplicates concurrent owner refreshes into one task and outbox wake', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', revisionId).set({
          id: revisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const request = () =>
        repository.request({
          agentId,
          cardId,
          conversationId,
          operationId,
          expectedRevisionId: revisionId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        });
      const results = await Promise.all(Array.from({ length: 8 }, request));
      expect(
        new Set(results.flatMap((result) => (result.ok ? [result.taskId] : [])).values()).size,
      ).toBe(1);
      expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
      expect((await store.collection('tasks').get()).size).toBe(1);
      expect((await store.collection('outbox').get()).size).toBe(1);
      const firstTaskId = results.find((result) => result.ok)?.taskId;
      if (!firstTaskId) throw new Error('refresh task was not created');
      expect((await store.doc('tasks', firstTaskId).get()).get('trigger')).toMatchObject({
        payload: { refreshCardId: cardId, refreshCardRevisionId: revisionId },
      });
      await store.doc('tasks', firstTaskId).update({ status: 'done' });
      const replay = await request();
      expect(replay).toMatchObject({ ok: true, taskId: firstTaskId, created: false });
      expect((await store.collection('tasks').get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('durably aliases a distinct same-revision operation to the active task', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    const firstOperationId = randomUUID();
    const retryOperationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', revisionId).set({
          id: revisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const request = (operationId: string) =>
        repository.request({
          agentId,
          cardId,
          conversationId,
          operationId,
          expectedRevisionId: revisionId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        });

      const first = await request(firstOperationId);
      if (!first.ok) throw new Error('initial refresh was not created');
      expect(first).toMatchObject({ ok: true, created: true, dispatch: 'outbox' });

      const alias = await request(retryOperationId);
      expect(alias).toMatchObject({
        ok: true,
        taskId: first.taskId,
        created: false,
        dispatch: 'outbox',
      });
      const operationKey = createHash('sha256')
        .update(`saved-card-refresh:${agentId}:${cardId}:${retryOperationId}`)
        .digest('hex');
      expect((await store.doc('taskEventKeys', operationKey).get()).data()).toMatchObject({
        taskId: first.taskId,
      });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
      expect(
        (await store.collection('outbox').where('taskId', '==', first.taskId).get()).size,
      ).toBe(1);
      expect(
        (await store.collection('conversations').where('agentId', '==', agentId).get()).size,
      ).toBe(1);

      await store.doc('tasks', first.taskId).update({ status: 'done' });
      const replayAfterCompletion = await request(retryOperationId);
      expect(replayAfterCompletion).toMatchObject({
        ok: true,
        taskId: first.taskId,
        created: false,
        dispatch: 'outbox',
      });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
      expect(
        (await store.collection('outbox').where('taskId', '==', first.taskId).get()).size,
      ).toBe(1);
      expect(
        (await store.collection('conversations').where('agentId', '==', agentId).get()).size,
      ).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects a stale revision before replaying an operation or reusing an active task', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const viewedRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', viewedRevisionId).set({
          id: viewedRevisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCardRevisions', currentRevisionId).set({
          id: currentRevisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: viewedRevisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const request = (requestedOperationId: string) =>
        repository.request({
          agentId,
          cardId,
          conversationId,
          operationId: requestedOperationId,
          expectedRevisionId: viewedRevisionId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        });
      const first = await request(operationId);
      if (!first.ok) throw new Error('initial refresh was not created');
      expect(first.created).toBe(true);
      await store.doc('generatedCards', cardId).update({ currentRevisionId });

      const replay = await request(operationId);
      const secondOperation = await request(randomUUID());
      for (const result of [replay, secondOperation])
        expect(result).toEqual({
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before starting another refresh.',
        });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
      expect(
        (await store.collection('outbox').where('taskId', '==', first.taskId).get()).size,
      ).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects replaying one operation ID against a newer card revision', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const viewedRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', viewedRevisionId).set({
          id: viewedRevisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCardRevisions', currentRevisionId).set({
          id: currentRevisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: viewedRevisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const request = (revisionId: string) =>
        repository.request({
          agentId,
          cardId,
          conversationId,
          operationId,
          expectedRevisionId: revisionId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        });
      const first = await request(viewedRevisionId);
      if (!first.ok) throw new Error('initial refresh was not created');
      expect(first.created).toBe(true);

      await store.doc('generatedCards', cardId).update({ currentRevisionId });
      const replay = await request(currentRevisionId);
      expect(replay).toEqual({
        ok: false,
        status: 409,
        error: 'This card changed. Reload it before starting another refresh.',
      });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
      expect(
        (await store.collection('outbox').where('taskId', '==', first.taskId).get()).size,
      ).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects an active refresh task tied to an older card revision', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const viewedRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const conversationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', viewedRevisionId).set({
          id: viewedRevisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCardRevisions', currentRevisionId).set({
          id: currentRevisionId,
          cardId,
          spec: { version: 2 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: viewedRevisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const first = await repository.request({
        agentId,
        cardId,
        conversationId,
        operationId: randomUUID(),
        expectedRevisionId: viewedRevisionId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      if (!first.ok) throw new Error('initial refresh was not created');
      expect(first.created).toBe(true);

      await store.doc('generatedCards', cardId).update({ currentRevisionId });
      const result = await repository.request({
        agentId,
        cardId,
        conversationId,
        operationId: randomUUID(),
        expectedRevisionId: currentRevisionId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toEqual({
        ok: false,
        status: 409,
        error: 'This card changed. Reload it before starting another refresh.',
      });

      await store.doc('cardRefreshKeys', cardId).delete();
      const queryReuse = await repository.request({
        agentId,
        cardId,
        conversationId,
        operationId: randomUUID(),
        expectedRevisionId: currentRevisionId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(queryReuse).toEqual({
        ok: false,
        status: 409,
        error: 'This card changed. Reload it before starting another refresh.',
      });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
      expect(
        (await store.collection('outbox').where('taskId', '==', first.taskId).get()).size,
      ).toBe(1);
      expect((await store.collection('taskEventKeys').get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('does not reveal or refresh another owner card', async () => {
    const store = emulatorStore();
    const ownerId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    try {
      await store.doc('generatedCards', cardId).set({
        id: cardId,
        agentId: ownerId,
        conversationId: null,
        currentRevisionId: revisionId,
        status: 'active',
        dismissedAt: null,
      });
      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId: randomUUID(),
        cardId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toEqual({ ok: false, error: 'Card not found.', status: 404 });
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('finds an older active imported refresh behind a newer completed task', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    const activeTaskId = randomUUID();
    const doneTaskId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
        store.doc('tasks', activeTaskId).set({
          id: activeTaskId,
          agentId,
          status: 'pending',
          queueGeneration: 0,
          trigger: { payload: { refreshCardId: cardId } },
          createdAt: new Date('2026-09-18T00:00:00Z'),
        }),
        store.doc('tasks', doneTaskId).set({
          id: doneTaskId,
          agentId,
          status: 'done',
          queueGeneration: 0,
          trigger: { payload: { refreshCardId: cardId } },
          createdAt: new Date('2026-09-19T00:00:00Z'),
        }),
      ]);
      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId,
        cardId,
        conversationId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toMatchObject({ ok: true, taskId: activeTaskId, created: false });
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('restores an archived primary conversation used as the fallback destination', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
          archived: true,
          archivedAt: new Date('2026-09-01T00:00:00Z'),
        }),
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId: null,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);

      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId,
        cardId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toMatchObject({ ok: true, created: true });
      const primary = await store.doc('conversations', conversationId).get();
      expect(primary.get('archivedAt')).toBeNull();
      expect(primary.get('archived')).toBe(false);
      if (!result.ok) throw new Error('refresh failed');
      expect((await store.doc('tasks', result.taskId).get()).get('conversationId')).toBe(
        conversationId,
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses to overwrite a foreign deterministic primary conversation', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const primaryId = deterministicPrimaryId(agentId);
    try {
      await Promise.all([
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId: null,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
        store.doc('conversations', primaryId).set({
          id: primaryId,
          agentId: randomUUID(),
          channel: 'email',
          trust: 'unknown',
          isPrimary: false,
        }),
      ]);
      await expect(
        new FirestoreCardRefreshRepository(store).request({
          agentId,
          cardId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        }),
      ).rejects.toThrow('identity collision');
      expect((await store.doc('conversations', primaryId).get()).get('channel')).toBe('email');
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });
});
