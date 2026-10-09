import { randomUUID } from 'node:crypto';
import { createFirestoreExecutionPersistence, createInstallationStore } from '@assistant/firestore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type AgentDeps, agentServices } from './deps.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore agent dashboard notifier with PostgreSQL offline',
  () => {
    const agentId = randomUUID();
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `agent-notices-${randomUUID()}`,
    });
    const persistence = createFirestoreExecutionPersistence(store, agentId, {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      revision: 'test',
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    });

    it('delivers owner updates and approval summaries into the owner chat without SQL', async () => {
      const primaryId = randomUUID();
      const workId = randomUUID();
      const taskId = randomUUID();
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' }),
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
      const phone = vi.fn(async () => {});
      const deps = {
        config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: agentId },
        firestoreStore: store,
        db: new Proxy(
          {},
          {
            get: () => {
              throw new Error('PostgreSQL must be unreachable');
            },
          },
        ),
        persistence,
        modules: { emailObservers: [] },
        outOfBandNotifier: { notifyOwner: phone, notifyApprovals: phone },
      } as unknown as AgentDeps;
      const notifier = agentServices(deps).ownerNotifier;
      await notifier.notifyOwner({ text: 'Task finished', taskId, conversationId: workId });
      await notifier.notifyApprovals([
        {
          taskId,
          conversationId: primaryId,
          shortCode: 'A1',
          summary: 'Already visible',
          purpose: 'Continue work',
        },
        {
          taskId,
          conversationId: workId,
          shortCode: 'A2',
          summary: 'Needs review',
          purpose: 'Continue work',
        },
      ]);
      const messages = await store
        .collection('messages')
        .where('conversationId', '==', primaryId)
        .get();
      expect(messages.size).toBe(2);
      expect(messages.docs.map((doc) => doc.get('text'))).toEqual(
        expect.arrayContaining(['Task finished', expect.stringContaining('1 action is waiting')]),
      );
      // The dashboard write comes first; the policy-gated phone legs follow (#409).
      expect(phone).toHaveBeenCalledTimes(2);
    });
  },
);
