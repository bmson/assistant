import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { googleModule } from '@assistant/modules';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { composeFirestoreAgent } from './deps.js';
import { runFirestoreSweep } from './firestore-sweep.js';
import { startPoller } from './poller.js';

const SPACE = {
  provider: 'synthetic',
  model: 'gmail-poller-fixture',
  dimensions: 1536,
  revision: '1',
};

async function waitUntil(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function accelerateMailTick(deps: ReturnType<typeof composeFirestoreAgent>) {
  const tick = deps.modules.ticks.find((candidate) => candidate.name === 'email-sync');
  if (!tick) throw new Error('The configured Google module did not install its email tick');
  // Keep the production poller, module tick function, and guards intact while
  // reducing its 30-second cadence in this local integration test.
  (tick as { everyTicks: number }).everyTicks = 1;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'composed Firestore Gmail poller activation fence',
  { timeout: 90_000 },
  () => {
    let store: InstallationStore | undefined;
    let stop: (() => void) | undefined;

    afterEach(async () => {
      stop?.();
      stop = undefined;
      if (store) await disposeStore(store);
      store = undefined;
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    async function compose(activation: 'pending_activation' | 'active') {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      store = emulatorStore();
      const agentId = randomUUID();
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Synthetic owner',
        email: 'owner@example.test',
        timezone: 'UTC',
      });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
      await store.doc('coordination', 'migration').set({ status: activation });
      await store.doc('rateLimits', 'task').set({
        scope: 'task',
        maxPerHour: null,
        maxPerDay: null,
        updatedAt: new Date(),
      });
      const deps = composeFirestoreAgent(
        loadConfig({
          PERSISTENCE_DRIVER: 'firestore',
          ASSISTANT_MODULES: 'google',
          ASSISTANT_WORKSPACE_ID: store.installationId,
          FIRESTORE_AGENT_ID: agentId,
          FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
          GCP_PROJECT: 'demo-assistant-test',
          QUEUE_DRIVER: 'local',
          OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
          GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
          GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
          BOT_GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-token',
          GMAIL_SYNC_ENABLED: 'true',
          EMAIL_OBSERVER_WORKER_ENABLED: 'true',
          GENERATIVE_CARDS_ENABLED: 'false',
          EMAIL_INGEST_MODE: 'direct',
        }),
      );
      const client = deps.modules.requireExports(googleModule);
      return { deps, client, agentId, store };
    }

    it('holds the composed Gmail poller, then resumes one fake inbound message after activation', async () => {
      const fixture = await compose('pending_activation');
      const providerCalls: string[] = [];
      let inboxMessageAvailable = false;
      let withdrawOnNextProfile = false;
      const client = fixture.client as unknown as {
        api: (url: string) => Promise<unknown>;
      };
      vi.spyOn(client, 'api').mockImplementation(async (url: string) => {
        providerCalls.push(url);
        if (url.endsWith('/profile')) {
          if (withdrawOnNextProfile) {
            withdrawOnNextProfile = false;
            await fixture.store.doc('coordination', 'migration').update({
              status: 'pending_activation',
            });
          }
          return { historyId: inboxMessageAvailable ? '101' : '100' };
        }
        if (url.includes('/history?'))
          return {
            history: inboxMessageAvailable
              ? [{ messagesAdded: [{ message: { id: 'mail-1' } }] }]
              : [],
          };
        if (url.includes('/messages/mail-1?'))
          return {
            id: 'mail-1',
            threadId: 'thread-1',
            internalDate: String(Date.now()),
            labelIds: ['INBOX'],
            snippet: 'Lunch Friday?',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Grace <grace@friend.test>' },
                { name: 'Subject', value: 'Lunch Friday?' },
                { name: 'Message-ID', value: '<mail-1@example.test>' },
                {
                  name: 'Authentication-Results',
                  value: 'mx.google.com; dmarc=pass header.from=friend.test',
                },
              ],
              body: { data: Buffer.from('Are you free for lunch Friday?').toString('base64url') },
            },
          };
        throw new Error(`Unexpected synthetic Gmail request: ${url}`);
      });
      await fixture.store.collection('contacts').add({
        id: randomUUID(),
        name: 'Grace',
        trust: 'known',
        emails: ['grace@friend.test'],
        aliases: [],
      });
      fixture.deps.router = {
        object: async () => ({
          ok: true,
          modelId: 'synthetic/offline',
          degraded: false,
          object: {
            category: 'personal',
            importance: 4,
            actionable: true,
            reason: 'synthetic fixture',
            dates: [],
          },
        }),
        embed: async (texts: string[]) => texts.map(() => new Array(1536).fill(0)),
      } as never;
      accelerateMailTick(fixture.deps);

      stop = startPoller(fixture.deps);
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect(providerCalls).toEqual([]);
      expect((await fixture.store.collection('gmailSyncState').get()).size).toBe(0);

      await fixture.store.doc('coordination', 'migration').update({ status: 'active' });
      await waitUntil(
        async () => (await fixture.store.collection('gmailSyncState').get()).size === 1,
        'post-activation Gmail baseline',
      );
      expect(providerCalls.filter((url) => url.endsWith('/profile'))).toHaveLength(1);
      expect((await fixture.store.collection('gmailSyncState').get()).size).toBe(1);

      const baselineState = await fixture.store.collection('gmailSyncState').get();
      withdrawOnNextProfile = true;
      await waitUntil(
        async () => providerCalls.filter((url) => url.endsWith('/profile')).length === 2,
        'profile read racing activation withdrawal',
      );
      await waitUntil(
        async () =>
          (await fixture.store.doc('coordination', 'migration').get()).get('status') ===
          'pending_activation',
        'withdrawn activation marker',
      );
      await waitUntil(async () => {
        const lock = await fixture.store.doc('coordination', 'gmail-sync-lock').get();
        const expiresAt = lock.get('expiresAt');
        const expiry =
          expiresAt instanceof Date
            ? expiresAt
            : expiresAt &&
                typeof expiresAt === 'object' &&
                'toDate' in expiresAt &&
                typeof expiresAt.toDate === 'function'
              ? expiresAt.toDate()
              : null;
        return Boolean(expiry && expiry.getTime() <= Date.now());
      }, 'withdrawal-raced Gmail sync lease release');
      const stateWhilePending = await fixture.store.collection('gmailSyncState').get();
      expect(stateWhilePending.docs[0]?.data()).toEqual(baselineState.docs[0]?.data());
      expect(providerCalls.filter((url) => url.includes('/history?'))).toHaveLength(0);
      await fixture.store.doc('coordination', 'migration').update({ status: 'active' });

      // The next tick sees the baseline and admits the newly arrived fake
      // message through the real installed module and Firestore repositories.
      inboxMessageAvailable = true;
      await waitUntil(
        async () =>
          (
            await fixture.store
              .collection('messages')
              .where('channelMessageId', '==', 'gmail:mail-1')
              .get()
          ).size === 1 &&
          (
            await fixture.store
              .collection('emailObserverWork')
              .where('sourceKey', '==', 'gmail:mail-1')
              .get()
          ).size > 0,
        'one durably admitted inbound Gmail message',
      );
      expect(
        (
          await fixture.store
            .collection('tasks')
            .where('externalEventId', '==', 'gmail:mail-1')
            .get()
        ).size,
      ).toBe(0);
      const sweep = await runFirestoreSweep(fixture.deps);
      expect(sweep.ready).toBe(true);
      if (sweep.ready) expect(sweep.report.emailObserverWorkClaimed).toBeGreaterThan(0);
      await waitUntil(
        async () =>
          (
            await fixture.store
              .collection('tasks')
              .where('externalEventId', '==', 'gmail:mail-1')
              .get()
          ).size === 1,
        'one drained inbound Gmail task',
      );
      expect(providerCalls.filter((url) => url.endsWith('/profile'))).toHaveLength(3);
      expect(providerCalls.filter((url) => url.includes('/history?'))).toHaveLength(1);
      expect(providerCalls.filter((url) => url.includes('/messages/mail-1?'))).toHaveLength(1);
      expect((await fixture.store.collection('gmailSyncState').get()).size).toBe(1);
      expect(
        (
          await fixture.store
            .collection('messages')
            .where('channelMessageId', '==', 'gmail:mail-1')
            .get()
        ).size,
      ).toBe(1);
      expect(
        (
          await fixture.store
            .collection('tasks')
            .where('externalEventId', '==', 'gmail:mail-1')
            .get()
        ).size,
      ).toBe(1);
      await waitUntil(async () => {
        const lock = await fixture.store.doc('coordination', 'gmail-sync-lock').get();
        const expiresAt = lock.get('expiresAt');
        const expiry =
          expiresAt instanceof Date
            ? expiresAt
            : expiresAt &&
                typeof expiresAt === 'object' &&
                'toDate' in expiresAt &&
                typeof expiresAt.toDate === 'function'
              ? expiresAt.toDate()
              : null;
        return Boolean(expiry && expiry.getTime() <= Date.now());
      }, 'Gmail sync lease release');
    });
  },
);
