import { randomUUID } from 'node:crypto';
import {
  createInstallationStore,
  FirestoreMessageRepository,
  FirestoreWatchRepository,
} from '@assistant/firestore';
import { describe, expect, it } from 'vitest';
import { drainWatchFireEffects } from './fire.js';
import { pollDueWebWatches } from './web-watches.js';

const start = new Date('2026-10-07T12:00:00Z');
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore repeated web-watch transitions',
  () => {
    it.each(['change', 'contains'] as const)(
      'keeps later %s transitions distinct while concurrent claims converge',
      async (mode) => {
        const store = createInstallationStore({
          projectId: 'demo-assistant-test',
          installationId: `web-cycles-${randomUUID()}`,
        });
        try {
          await store.doc('agents', 'owner').set({ id: 'owner' });
          const watches = new FirestoreWatchRepository(store);
          const watch = await watches.create({
            agentId: 'owner',
            kind: 'web',
            tier: 'notify',
            name: 'Repeated cycles',
            match: { url: 'https://example.test', mode, pattern: 'in stock' },
            nextPollAt: start,
            pollIntervalSeconds: 60,
            state: {},
            maxFires: 5,
            expiresAt: new Date(start.getTime() + 86_400_000),
          });
          const notices: string[] = [];
          const deps = {
            watches,
            messages: new FirestoreMessageRepository(store),
            notifyOwner: async ({ text }: { text: string }) => {
              notices.push(text);
            },
          };
          let text = 'Sold out';
          const fetch = async () => ({ text, finalUrl: 'https://example.test' });
          await pollDueWebWatches(deps, { now: start, fetch });
          for (const [minute, page] of [
            [5, 'In stock'],
            [10, 'Sold out'],
            [15, 'In stock'],
          ] as const) {
            text = page;
            const now = new Date(start.getTime() + minute * 60_000);
            await Promise.all([
              pollDueWebWatches(deps, { now, fetch }),
              pollDueWebWatches(deps, { now, fetch }),
            ]);
          }
          const expected = mode === 'contains' ? 2 : 3;
          const fires = await store.collection('watchFires').where('watchId', '==', watch.id).get();
          expect(fires.size).toBe(expected);
          expect(new Set(fires.docs.map((doc) => doc.get('triggerRef'))).size).toBe(expected);
          expect((await store.doc('watches', watch.id).get()).get('fireCount')).toBe(expected);
          expect(notices).toHaveLength(expected);
          expect(
            (
              await store
                .collection('messages')
                .where('conversationId', '==', watch.conversationId)
                .get()
            ).size,
          ).toBe(expected);
          const latestFire = fires.docs.reduce((latest, candidate) =>
            candidate.get('createdAt').toMillis() > latest.get('createdAt').toMillis()
              ? candidate
              : latest,
          );
          if (!latestFire) throw new Error('watch fire missing');
          const fireId = latestFire.get('id') as string;
          const effects = await watches.fireEffectsForFire('owner', fireId);
          expect(effects.map((effect) => effect.status).sort()).toEqual(['delivered', 'unknown']);
          const dashboardEffect = effects.find((effect) => effect.kind === 'dashboard_notice');
          if (!dashboardEffect) throw new Error('dashboard effect missing');
          await store
            .doc('watchFireEffects', dashboardEffect.id)
            .update({ status: 'failed', updatedAt: new Date() });
          await drainWatchFireEffects(deps, 'owner', fireId, new Date());
          expect(
            (await watches.fireEffectsForFire('owner', fireId)).find(
              (effect) => effect.kind === 'dashboard_notice',
            )?.status,
          ).toBe('delivered');
        } finally {
          await store.db.recursiveDelete(store.root);
          await store.db.terminate();
        }
      },
      60_000,
    );
  },
);
