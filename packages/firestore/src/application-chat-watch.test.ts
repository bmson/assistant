import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { documentKey, type InstallationStore } from './store.js';

type Row = Record<string, unknown>;
type FakeSnapshot = {
  id: string;
  exists: boolean;
  updateTime: Timestamp;
  get: (field: string) => unknown;
  data: () => Row;
};

function snapshot(id: string, data: Row, version = 1, documentId = documentKey(id)): FakeSnapshot {
  return {
    id: documentId,
    exists: true,
    updateTime: new Timestamp(1, version),
    get: (field) => data[field],
    data: () => data,
  };
}

function makeWatchFixture(
  overrides: {
    conversation?: Row;
    task?: Row;
    conversationOnAttach?: Row;
    taskOnAttach?: Row;
    conversationAttachError?: Error;
    throwOnTaskAttach?: Error;
    conversationDocumentId?: string;
  } = {},
) {
  const agentId = 'watch-owner';
  const conversationId = 'watch-conversation';
  const taskId = 'watch-task';
  const conversationData: Row = {
    id: conversationId,
    agentId,
    channel: 'chat',
    updatedAt: new Date(1_000),
    ...overrides.conversation,
  };
  const taskData: Row = {
    id: taskId,
    agentId,
    conversationId,
    status: 'running',
    progress: 'Step 1',
    ...overrides.task,
  };
  const releases: Array<{ collection: string; count: number }> = [];
  const refs: Array<{ collection: string; id: string }> = [];

  function makeRef(
    collection: string,
    id: string,
    data: Row,
    onAttach?: Row,
    snapshotDocumentId?: string,
  ) {
    let current = snapshot(id, data, 1, snapshotDocumentId);
    const listeners: Array<{
      next: (value: FakeSnapshot) => void;
      error: (error: unknown) => void;
      active: boolean;
    }> = [];
    return {
      get id() {
        return documentKey(id);
      },
      get current() {
        return current;
      },
      get: vi.fn(async () => current),
      onSnapshot: vi.fn((next: (value: FakeSnapshot) => void, error: (reason: unknown) => void) => {
        if (collection === 'tasks' && overrides.throwOnTaskAttach)
          throw overrides.throwOnTaskAttach;
        const listener = { next, error, active: true };
        listeners.push(listener);
        next(snapshot(id, onAttach ?? data, onAttach ? 2 : 1, snapshotDocumentId));
        if (collection === 'conversations' && overrides.conversationAttachError) {
          error(overrides.conversationAttachError);
        }
        return () => {
          if (!listener.active) return;
          listener.active = false;
          releases.push({ collection, count: 1 });
        };
      }),
      emit(nextData: Row, version: number) {
        current = snapshot(id, nextData, version, snapshotDocumentId);
        for (const listener of listeners) {
          if (listener.active) listener.next(current);
        }
      },
      fail(error: unknown) {
        for (const listener of listeners) {
          if (listener.active) listener.error(error);
        }
      },
      get listenerCount() {
        return listeners.filter((listener) => listener.active).length;
      },
    };
  }

  const conversationRef = makeRef(
    'conversations',
    conversationId,
    conversationData,
    overrides.conversationOnAttach,
    overrides.conversationDocumentId,
  );
  const taskRef = makeRef('tasks', taskId, taskData, overrides.taskOnAttach);
  const db = {
    getAll: vi.fn(async (...documents: Array<{ current: FakeSnapshot }>) =>
      documents.map((document) => document.current),
    ),
  };
  const store = {
    db,
    doc: vi.fn((collection: string, id: string) => {
      refs.push({ collection, id });
      if (collection === 'conversations' && id === conversationId) return conversationRef;
      if (collection === 'tasks' && id === taskId) return taskRef;
      throw new Error(`Unexpected watch target: ${collection}/${id}`);
    }),
  } as unknown as InstallationStore;
  const repository = new FirestoreApplicationChatPersistence(store, agentId);

  return {
    agentId,
    conversationId,
    taskId,
    conversationData,
    taskData,
    conversationRef,
    taskRef,
    db,
    refs,
    releases,
    repository,
    input: (signal: AbortSignal, onChange = vi.fn(), onError = vi.fn()) => ({
      agentId,
      conversationId,
      taskId,
      signal,
      onChange,
      onError,
    }),
  };
}

describe('Firestore application chat read-only change watch', () => {
  it('fails closed on direct conversation reads with mismatched identity or ownership', async () => {
    const cases: Array<{
      name: string;
      conversation?: Row;
      conversationDocumentId?: string;
      expected: boolean;
    }> = [
      { name: 'valid owner and identity', expected: true },
      {
        name: 'wrong embedded conversation ID',
        conversation: { id: 'foreign-conversation' },
        expected: false,
      },
      {
        name: 'wrong document key',
        conversationDocumentId: 'foreign-document-key',
        expected: false,
      },
      { name: 'foreign agent', conversation: { agentId: 'other-owner' }, expected: false },
      { name: 'wrong channel', conversation: { channel: 'sms' }, expected: false },
    ];

    for (const testCase of cases) {
      const fixture = makeWatchFixture({
        conversation: testCase.conversation,
        conversationDocumentId: testCase.conversationDocumentId,
      });
      const conversation = await fixture.repository.getConversation(
        fixture.agentId,
        fixture.conversationId,
      );

      expect(conversation !== null, testCase.name).toBe(testCase.expected);
      expect(fixture.conversationRef.get).toHaveBeenCalledOnce();
      expect(fixture.conversationRef.onSnapshot).not.toHaveBeenCalled();
      expect(fixture.db.getAll).not.toHaveBeenCalled();
      expect(fixture.taskRef.onSnapshot).not.toHaveBeenCalled();
    }
  });

  it('watches exactly the scoped conversation and task and only emits empty readiness hints', async () => {
    const fixture = makeWatchFixture();
    const controller = new AbortController();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(controller.signal, onChange, onError),
    );

    expect(watch).not.toBeNull();
    expect(fixture.db.getAll).toHaveBeenCalledTimes(1);
    expect(fixture.db.getAll.mock.calls[0]).toHaveLength(2);
    expect(fixture.refs).toEqual([
      { collection: 'conversations', id: fixture.conversationId },
      { collection: 'tasks', id: fixture.taskId },
    ]);
    expect(fixture.conversationRef.onSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.taskRef.onSnapshot).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();

    // The conversation field is unchanged within a millisecond, but Firestore's
    // exact document update time changed. This is only a best-effort wake hint.
    fixture.conversationRef.emit({ ...fixture.conversationData }, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([]);

    fixture.taskRef.emit({ ...fixture.taskData, progress: 'Step 2' }, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    fixture.taskRef.emit({ ...fixture.taskData, status: 'done' }, 3);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    watch?.close();
    watch?.close();
    expect(fixture.releases).toEqual([
      { collection: 'conversations', count: 1 },
      { collection: 'tasks', count: 1 },
    ]);
    fixture.conversationRef.emit({ ...fixture.conversationData }, 4);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('captures a change between preflight and the listener initial snapshot', async () => {
    const fixture = makeWatchFixture({
      conversationOnAttach: {
        id: 'watch-conversation',
        agentId: 'watch-owner',
        channel: 'chat',
        updatedAt: new Date(2_000),
      },
    });
    const onChange = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, onChange),
    );

    expect(watch).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([]);
    watch?.close();
  });

  it('does not attach listeners for malformed or foreign conversation and task identities', async () => {
    const cases: Array<{ conversation?: Row; task?: Row }> = [
      { conversation: { id: 'wrong-conversation' } },
      { conversation: { agentId: 'other-owner' } },
      { conversation: { channel: 'sms' } },
      { task: { id: 'wrong-task' } },
      { task: { agentId: 'other-owner' } },
      { task: { conversationId: 'other-conversation' } },
    ];

    for (const override of cases) {
      const fixture = makeWatchFixture(override);
      const onChange = vi.fn();
      const onError = vi.fn();
      const watch = await fixture.repository.watchChatChanges(
        fixture.input(new AbortController().signal, onChange, onError),
      );
      expect(watch).toBeNull();
      expect(fixture.refs).toHaveLength(2);
      expect(fixture.conversationRef.onSnapshot).not.toHaveBeenCalled();
      expect(fixture.taskRef.onSnapshot).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
    }
  });

  it('closes both listeners on abort and ignores subsequent callbacks', async () => {
    const fixture = makeWatchFixture();
    const controller = new AbortController();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(controller.signal, onChange, onError),
    );

    controller.abort();
    watch?.close();
    expect(fixture.releases).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    fixture.conversationRef.emit({ ...fixture.conversationData }, 2);
    fixture.taskRef.emit({ ...fixture.taskData, status: 'done' }, 2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes both listeners once on asynchronous listener error', async () => {
    const fixture = makeWatchFixture();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, onChange, onError),
    );
    const error = new Error('synthetic watch interruption');

    fixture.taskRef.fail(error);
    watch?.close();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(fixture.releases).toHaveLength(2);
    fixture.conversationRef.emit({ ...fixture.conversationData }, 2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cleans up if a listener errors synchronously before its unsubscribe is returned', async () => {
    const error = new Error('synchronous initial listener failure');
    const fixture = makeWatchFixture({ conversationAttachError: error });
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, vi.fn(), onError),
    );

    expect(watch).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(fixture.conversationRef.onSnapshot).toHaveBeenCalledOnce();
    expect(fixture.taskRef.onSnapshot).not.toHaveBeenCalled();
    expect(fixture.releases).toEqual([{ collection: 'conversations', count: 1 }]);
  });

  it('closes the first listener if setup of the second listener throws', async () => {
    const error = new Error('synthetic task listener setup failure');
    const fixture = makeWatchFixture({ throwOnTaskAttach: error });
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, vi.fn(), onError),
    );

    expect(watch).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(fixture.conversationRef.onSnapshot).toHaveBeenCalledOnce();
    expect(fixture.taskRef.onSnapshot).toHaveBeenCalledOnce();
    expect(fixture.releases).toEqual([{ collection: 'conversations', count: 1 }]);
  });

  it('closes both listeners on the 65th raw callback and ignores queued callbacks afterward', async () => {
    const fixture = makeWatchFixture();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, onChange, onError),
    );

    // Two listener initial snapshots plus 62 unchanged/progress-only callbacks
    // reach the cap without emitting a readiness hint.
    for (let version = 2; version <= 63; version++) {
      fixture.taskRef.emit({ ...fixture.taskData, progress: `Step ${version}` }, version);
    }
    expect(fixture.conversationRef.listenerCount).toBe(1);
    expect(fixture.taskRef.listenerCount).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    fixture.taskRef.emit({ ...fixture.taskData, progress: 'Step 64' }, 64);
    expect(fixture.releases).toHaveLength(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(fixture.conversationRef.listenerCount).toBe(0);
    expect(fixture.taskRef.listenerCount).toBe(0);

    fixture.taskRef.emit({ ...fixture.taskData, status: 'done' }, 65);
    watch?.close();
    expect(fixture.releases).toHaveLength(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on an ongoing conversation scope change', async () => {
    const fixture = makeWatchFixture();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = await fixture.repository.watchChatChanges(
      fixture.input(new AbortController().signal, onChange, onError),
    );

    fixture.conversationRef.emit({ ...fixture.conversationData, agentId: 'other-owner' }, 2);
    expect(watch).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(fixture.releases).toHaveLength(2);
  });
});
