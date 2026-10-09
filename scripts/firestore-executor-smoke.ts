import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask, TaskStateSchema } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence, type InstallationStore } from '@assistant/firestore';
import { finalChannelDelivery } from '@assistant/persistence';

/** Synthetic context queries plus real executor finalization; no SQL or model network access. */
export async function firestoreExecutorSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const persistence = createFirestoreExecutionPersistence(store, agentId, {
    provider: 'synthetic',
    model: 'recovery-fixture',
    dimensions: 1536,
    revision: '1',
  });
  await store
    .doc('conversations', conversationId)
    .set({ id: conversationId, agentId, channel: 'chat' });
  const { task } = await persistence.tasks.createTask({
    agentId,
    conversationId,
    type: 'chat_turn',
    trust: 'owner',
    trigger: { source: 'chat' },
  });
  const time = new Date('2026-09-12T12:00:00Z');
  const batch = store.db.batch();
  for (let index = 0; index < 30; index++) {
    const id = `${conversationId}-${String(index).padStart(3, '0')}`;
    batch.set(store.doc('messages', id), {
      id,
      conversationId,
      taskId: null,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `Synthetic message ${index}`,
      createdAt: time,
      channelMessageId: `gmail:${id}`,
    });
  }
  await batch.commit();
  const context = persistence.executionContext;
  const history = await context.seedHistory({
    agentId,
    conversationId,
    before: new Date(time.getTime() + 1),
    limit: 20,
  });
  assert.equal(history.length, 20);
  assert.equal(history[0]?.text, 'Synthetic message 10');
  assert.equal(history.at(-1)?.text, 'Synthetic message 29');
  const cursor = await context.getLatestOwnerReplyCursor({ agentId, conversationId });
  assert.equal(cursor?.cursor?.id, `${conversationId}-029`);
  const replies = await context.getOwnerRepliesAfter({
    agentId,
    conversationId,
    after: { createdAt: time, id: `${conversationId}-028` },
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.text, 'Synthetic message 29');
  assert.equal(
    (
      await context.getInboundMessage({
        agentId,
        conversationId,
        channelMessageId: `gmail:${conversationId}-004`,
      })
    )?.text,
    'Synthetic message 4',
  );
  assert.deepEqual(
    await context.seedHistory({ agentId: randomUUID(), conversationId, before: new Date() }),
    [],
  );

  await store.doc('tasks', task.id).update({
    state: TaskStateSchema.parse({
      pendingFinal: {
        text: 'Synthetic verified final',
        progress: 'Synthetic completion',
        terminalStatus: 'done',
        outcome: 'done',
      },
    }),
  });
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected SQL/model dependency: ${String(property)}`);
      },
    },
  );
  let delivered = 0;
  const deps: ExecutorDeps = {
    db: unavailable as Db,
    router: unavailable as ExecutorDeps['router'],
    dispatcher: unavailable as ExecutorDeps['dispatcher'],
    persistence,
    deliverFinal: async (_task, _text, attemptId) => {
      delivered++;
      return finalChannelDelivery('dashboard', 'accepted', attemptId);
    },
  };
  assert.equal((await executeTask(deps, task.id)).outcome, 'done');
  assert.equal((await executeTask(deps, task.id)).outcome, 'not_claimable');
  assert.equal(delivered, 1);
  assert.equal(
    await persistence.executionEvidence.finalMessageExists({
      agentId,
      taskId: task.id,
      conversationId,
      text: 'Synthetic verified final',
    }),
    true,
  );
  assert.deepEqual(
    await persistence.executionEvidence.taskEvidence({ agentId, taskId: task.id }),
    [],
  );
  assert.deepEqual(
    await persistence.executionEvidence.conversationEvidence({
      agentId,
      conversationId,
      excludeTaskId: task.id,
    }),
    [],
  );
  assert.deepEqual(
    await persistence.executionEvidence.checklistDecisions({ agentId, taskId: task.id }),
    [],
  );
  assert.equal((await store.doc('responseChecks', task.id).get()).exists, true);
  return {
    history: history.length,
    equalTimestampReplies: replies.length,
    finalized: true,
    delivered,
  };
}
