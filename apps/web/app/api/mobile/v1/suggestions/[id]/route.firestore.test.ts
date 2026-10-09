import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreWatchRepository,
  suggestionIdFor,
} from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn(), sqlCalls: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server')>('@/lib/server');
  return {
    ...actual,
    getDb: () => {
      auth.sqlCalls();
      throw new Error('PostgreSQL must be offline for Firestore suggestion decisions');
    },
  };
});

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)(
  'Firestore mobile suggestion decisions with PostgreSQL offline',
  () => {
    const installationId = `mobile-suggestions-${randomUUID()}`;
    const agentId = randomUUID();
    const suggestionId = randomUUID();
    const foreignId = randomUUID();
    const conversationId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    let route: typeof import('./route.js');

    beforeAll(async () => {
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
      );
      vi.stubEnv('LLM_PROVIDER', 'vertex');
      vi.stubEnv('ASSISTANT_MODULES', 'minimal');
      vi.stubEnv('QUEUE_DRIVER', 'local');
      vi.stubEnv('CANARY_ENABLED', 'false');
      vi.stubEnv('LOCATION_PING_SECRET', '');
      resetConfigForTest();
      auth.allowed.mockResolvedValue(true);
      route = await import('./route.js');
      const row = (id: string, owner: string) => ({
        id,
        agentId: owner,
        conversationId,
        origin: 'watch',
        proposedAction: 'Review the update.',
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        snoozedUntil: null,
        acceptedTaskId: null,
      });
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          archivedAt: null,
          isPrimary: true,
        }),
        store.doc('suggestions', suggestionId).set(row(suggestionId, agentId)),
        store.doc('suggestions', foreignId).set(row(foreignId, randomUUID())),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const post = (id: string, decision: string) =>
      route.POST(
        new Request(`https://example.com/api/mobile/v1/suggestions/${id}`, {
          method: 'POST',
          body: JSON.stringify({ decision }),
        }),
        { params: Promise.resolve({ id }) },
      );

    it.each(['accepted', 'dismissed', 'snoozed'])(
      'answers an actual watch proposal with %s and deduplicates acceptance',
      async (decision) => {
        const watches = new FirestoreWatchRepository(store);
        const now = new Date();
        const watch = await watches.create({
          agentId,
          conversationId,
          kind: 'email',
          tier: 'suggest',
          name: 'Owner update',
          match: { expectedSenderEmails: ['owner@example.com'] },
          maxFires: 5,
          expiresAt: new Date(now.getTime() + 86400000),
        });
        const triggerRef = `test-${decision}`;
        await watches.recordFire({
          watchId: watch.id,
          agentId,
          triggerRef,
          summary: 'Update',
          excerpt: 'Please review',
          now,
        });
        const committed = await watches.commitSuggestion({
          watchId: watch.id,
          agentId,
          triggerRef,
          summary: 'Review?',
          proposedAction: 'Review the update.',
          now,
        });
        expect(committed?.suggestion.id).toBe(
          suggestionIdFor(agentId, `watch:${watch.id}:${triggerRef}`),
        );
        if (!committed) throw new Error('No committed watch proposal');
        const before = (await store.collection('tasks').get()).size;
        expect((await post(committed.suggestion.id, decision)).status).toBe(200);
        if (decision === 'accepted') {
          expect((await post(committed.suggestion.id, decision)).status).toBe(200);
          expect((await store.collection('tasks').get()).size).toBe(before + 1);
        }
      },
    );

    it('retains the exact legacy watch identity without creating a duplicate proposal', async () => {
      const legacyId = `watch-suggestion:${'a'.repeat(64)}`;
      await store.doc('suggestions', legacyId).set({
        id: legacyId,
        agentId,
        conversationId,
        origin: 'watch',
        proposedAction: 'Review the old update.',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86400000),
        acceptedTaskId: null,
      });
      expect((await post(legacyId, 'accepted')).status).toBe(200);
      expect((await post(legacyId, 'accepted')).status).toBe(200);
      expect((await post('watch-suggestion:invalid', 'dismissed')).status).toBe(400);
    });

    it('accepts once and refuses a foreign suggestion without opening SQL', async () => {
      const foreign = await post(foreignId, 'accepted');
      expect(foreign.status).toBe(409);
      const before = (await store.collection('tasks').get()).size;
      const first = await post(suggestionId, 'accepted');
      const second = await post(suggestionId, 'accepted');
      expect(first.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect((await store.collection('tasks').get()).size).toBe(before + 1);
      expect(auth.sqlCalls).not.toHaveBeenCalled();
    });
  },
);
