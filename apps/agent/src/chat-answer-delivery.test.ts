import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { executeTask, getAgent, TaskStateSchema } from '@assistant/core';
import { conversations, messages, notificationOutbox, tasks } from '@assistant/db';
import { notificationDeliveryKey } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { ApnsClient } from '@assistant/tools/modules/push';
import { TwilioClient } from '@assistant/tools/modules/sms';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { buildDeps, composeFirestoreAgent } from './deps.js';
import { executorDeps } from './executor-deps.js';

afterEach(() => {
  resetConfigForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function reply(agentId: string, conversationId: string) {
  const task = taskFixture({ id: randomUUID(), agentId, conversationId, reminderId: '' });
  task.type = 'chat_turn';
  task.trigger = {};
  task.state = TaskStateSchema.parse({
    pendingFinal: {
      text: 'Private synthetic final answer.',
      progress: 'Completed',
      terminalStatus: 'done',
      outcome: 'done',
    },
  });
  return task;
}

function expectPush(send: ReturnType<typeof fakePush>, agentId: string, conversationId: string) {
  expect(send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      title: 'Assistant',
      body: 'Your reply is ready.',
      category: 'ASSISTANT_UPDATE',
      data: { route: 'chat', agentId, conversationId },
    }),
  );
}

function fakePush() {
  vi.spyOn(ApnsClient.prototype, 'configured').mockReturnValue(true);
  return vi
    .spyOn(ApnsClient.prototype, 'send')
    .mockResolvedValue({ ok: true, apnsId: 'synthetic' });
}

describe('secondary conversation answer delivery', () => {
  it('replays a PostgreSQL final with push and SMS installed but never mirrors or sends SMS', async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    vi.stubEnv('ASSISTANT_MODULES', 'push,sms');
    vi.stubEnv('OWNER_PHONE', '+14155550100');
    const push = fakePush();
    vi.spyOn(TwilioClient.prototype, 'configured').mockReturnValue(true);
    const sms = vi
      .spyOn(TwilioClient.prototype, 'send')
      .mockRejectedValue(new Error('Unexpected SMS'));
    const deps = buildDeps();
    const runtime = executorDeps(deps);
    const { id: agentId } = await getAgent(deps.db);
    const secondary = randomUUID();
    const task = reply(agentId, secondary);
    const token = randomUUID().replaceAll('-', '').repeat(2);
    const devices = deps.persistence?.deviceTokens;
    if (!devices) throw new Error('No device token repository');
    await devices.register(agentId, { token, platform: 'ios', environment: 'sandbox' });
    try {
      await deps.db.insert(conversations).values({ id: secondary, agentId, channel: 'chat' });
      await deps.db.insert(tasks).values(task);
      expect(await executeTask(runtime, task.id)).toMatchObject({ outcome: 'done' });
      expect(await executeTask(runtime, task.id)).toEqual({ outcome: 'not_claimable' });
      expectPush(push, agentId, secondary);
      expect(sms).not.toHaveBeenCalled();
      expect(
        await deps.db
          .select({ conversationId: messages.conversationId, text: messages.text })
          .from(messages)
          .where(eq(messages.taskId, task.id)),
      ).toEqual([{ conversationId: secondary, text: 'Private synthetic final answer.' }]);
      const receipts = await deps.db
        .select({ adapter: notificationOutbox.adapter, status: notificationOutbox.status })
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.agentId, agentId),
            eq(
              notificationOutbox.deliveryKey,
              notificationDeliveryKey(
                'outbox',
                agentId,
                notificationDeliveryKey('task-answer', task.id),
              ),
            ),
          ),
        );
      expect(receipts).toEqual([{ adapter: 'push', status: 'delivered' }]);
    } finally {
      await devices.invalidate(token);
    }
  });

  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
    'replays a Firestore final with push as the only installed module',
    async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      const push = fakePush();
      const store = emulatorStore();
      const agentId = randomUUID();
      const secondary = randomUUID();
      const primary = randomUUID();
      const task = reply(agentId, secondary);
      try {
        const deps = composeFirestoreAgent(
          loadConfig({
            PERSISTENCE_DRIVER: 'firestore',
            ASSISTANT_MODULES: 'push',
            ASSISTANT_WORKSPACE_ID: store.installationId,
            FIRESTORE_AGENT_ID: agentId,
            FIRESTORE_EMBEDDING_SPACE:
              '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
            GCP_PROJECT: 'demo-assistant-test',
            QUEUE_DRIVER: 'local',
            OPENROUTER_API_KEY: 'synthetic',
          }),
        );
        const devices = deps.persistence?.deviceTokens;
        if (!devices) throw new Error('No device token repository');
        await store
          .doc('agents', agentId)
          .set({ id: agentId, name: 'Private Name', timezone: 'UTC' });
        await store.doc('conversations', primary).set({
          id: primary,
          agentId,
          channel: 'chat',
          isPrimary: true,
          archivedAt: null,
        });
        await store.doc('conversations', secondary).set({
          id: secondary,
          agentId,
          channel: 'chat',
          isPrimary: false,
          archivedAt: null,
        });
        await store.doc('tasks', task.id).set(task);
        await devices.register(agentId, {
          token: 'a'.repeat(64),
          platform: 'ios',
          environment: 'sandbox',
        });
        const runtime = executorDeps(deps);
        expect(await executeTask(runtime, task.id)).toMatchObject({ outcome: 'done' });
        expect(await executeTask(runtime, task.id)).toEqual({ outcome: 'not_claimable' });
        expectPush(push, agentId, secondary);
        const rows = await store.collection('messages').where('taskId', '==', task.id).get();
        expect(rows.docs.map((row) => [row.get('conversationId'), row.get('text')])).toEqual([
          [secondary, 'Private synthetic final answer.'],
        ]);
        const receipts = await store.collection('notificationOutbox').get();
        expect(receipts.docs.map((row) => [row.get('adapter'), row.get('status')])).toEqual([
          ['push', 'delivered'],
        ]);
      } finally {
        await disposeStore(store);
      }
    },
  );
});
