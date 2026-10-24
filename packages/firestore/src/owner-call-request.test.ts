import { describe, expect, it } from 'vitest';
import { readFirestoreOwnerCallRequest } from './owner-call-request.js';
import { documentKey, type InstallationStore } from './store.js';

// Plain snapshots/references only: this fixture never creates Firestore or a datastore client.
function fixture(
  change:
    | 'none'
    | 'physical-message-id'
    | 'embedded-message-id'
    | 'physical-task-id'
    | 'physical-conversation-id' = 'none',
) {
  const agentId = 'owner',
    taskId = 'task/owner',
    conversationId = 'conversation/owner',
    messageId = 'message/owner';
  const clientOperationId = '11111111-1111-4111-8111-111111111111',
    text = 'Call +14155550123 now.';
  const message = {
    id: messageId,
    taskId,
    conversationId,
    role: 'user',
    origin: 'owner',
    text,
    hiddenAt: null as Date | null,
    createdAt: new Date('2026-10-23T12:00:00.000Z'),
  };
  const task = {
    id: taskId,
    agentId,
    conversationId,
    trust: 'owner',
    type: 'chat_turn',
    status: 'running',
    externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
    trigger: {
      source: 'chat',
      agentId,
      conversationId,
      trust: 'owner',
      payload: {
        text,
        triggerMessageId: messageId,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId,
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'streaming',
        },
      },
    },
  };
  function snapshot<T extends { id: string }>(record: T, physicalId = documentKey(record.id)) {
    return { id: physicalId, exists: true, data: () => record };
  }
  const messageSnapshot = snapshot(
    change === 'embedded-message-id' ? { ...message, id: 'different/message' } : message,
    change === 'physical-message-id' ? documentKey('different/message') : documentKey(messageId),
  );
  const taskSnapshot = snapshot(
    task,
    change === 'physical-task-id' ? documentKey('different/task') : documentKey(taskId),
  );
  const conversationSnapshot = snapshot(
    { id: conversationId, agentId },
    change === 'physical-conversation-id'
      ? documentKey('different/conversation')
      : documentKey(conversationId),
  );
  const querySnapshot = { size: 1, docs: [messageSnapshot] };
  const query = { where: () => query, limit: () => query, get: async () => querySnapshot };
  const store = {
    doc: (collection: string, id: string) => ({
      get: async () =>
        collection === 'tasks' && id === taskId
          ? taskSnapshot
          : collection === 'conversations' && id === conversationId
            ? conversationSnapshot
            : { id: documentKey(id), exists: false, data: () => undefined },
    }),
    collection: () => query,
  } as unknown as InstallationStore;
  const tx = {
    get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
  } as unknown as import('@google-cloud/firestore').Transaction;
  return { store, tx, agentId, taskId, messageId, task, message, querySnapshot, snapshot };
}

describe('Firestore admitted owner request physical document identity', () => {
  it.each([false, true])(
    'derives an actual encoded-ID proof (transaction=%s)',
    async (transactional) => {
      const f = fixture();
      expect(documentKey(f.messageId)).not.toBe(f.messageId);
      const proof = await readFirestoreOwnerCallRequest(
        f.store,
        f.agentId,
        f.taskId,
        'running',
        transactional ? f.tx : undefined,
      );
      expect(proof).toMatchObject({
        agentId: f.agentId,
        taskId: f.taskId,
        ownerMessageId: f.messageId,
        recipientRequest: { kind: 'explicit_number', recipientE164: '+14155550123' },
      });
    },
  );
  it.each([
    'physical-message-id',
    'embedded-message-id',
    'physical-task-id',
    'physical-conversation-id',
  ] as const)('rejects mismatched %s rather than trusting the embedded ID', async (change) => {
    const f = fixture(change);
    expect(
      await readFirestoreOwnerCallRequest(f.store, f.agentId, f.taskId, 'running', f.tx),
    ).toBeNull();
  });
  it('fails closed on an invalid query row instead of silently selecting an older valid owner message', async () => {
    const f = fixture('physical-message-id');
    f.querySnapshot.docs.push(f.snapshot(f.message));
    f.querySnapshot.size = 2;
    expect(
      await readFirestoreOwnerCallRequest(f.store, f.agentId, f.taskId, 'running', f.tx),
    ).toBeNull();
  });
  it('preserves lifecycle and hidden-source fences with real encoded document IDs', async () => {
    const f = fixture();
    expect(
      await readFirestoreOwnerCallRequest(f.store, f.agentId, f.taskId, 'waiting_approval', f.tx),
    ).toBeNull();
    f.message.hiddenAt = new Date();
    expect(
      await readFirestoreOwnerCallRequest(f.store, f.agentId, f.taskId, 'running', f.tx),
    ).toBeNull();
  });
});
