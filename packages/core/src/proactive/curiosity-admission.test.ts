import { randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  type Db,
  deviceTokens,
  maintenanceCursors,
  messages,
  notificationOutbox,
  notificationPrefs,
  proactivePings,
  suggestions,
} from '@assistant/db';
import {
  FirestoreGraphCuriosityRepository,
  FirestoreNotificationOutboxRepository,
  FirestoreOwnerNoticeRepository,
} from '@assistant/firestore';
import {
  type CuriosityQuestionInput,
  type CuriosityQuestionOutcome,
  curiosityDeliveryKey,
  curiosityNudgeChannel,
  drainNotificationOutbox,
  type NotificationOutboxRepository,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresNotificationOutboxRepository } from '../../../db/src/notification-outbox-repository.js';
import { createPostgresNudgePolicyRepository } from '../../../db/src/nudge-policy-repository.js';
import { FirestoreNudgePolicyRepository } from '../../../firestore/src/nudge-policy.js';
import type { InstallationStore } from '../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { admitPostgresCuriosityQuestion } from './curiosity-admission.js';

for (const backend of ['postgres', 'firestore'] as const) {
  describe.skipIf(backend === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${backend} curiosity atomic admission`,
    () => {
      let db: Db | undefined;
      let store: InstallationStore | undefined;
      let graph: FirestoreGraphCuriosityRepository | undefined;
      let agentId: string;
      let deviceToken: string;
      let input: CuriosityQuestionInput;
      let admit: (request: CuriosityQuestionInput) => Promise<CuriosityQuestionOutcome>;
      beforeEach(async () => {
        agentId = randomUUID();
        deviceToken = `curiosity-device-${randomUUID()}`;
        input = {
          agentId,
          key: `gap:missing:${randomUUID()}:works_at`,
          question: 'Would you like me to remember where Alex works?',
          now: new Date('2026-10-07T12:00:00.000Z'),
          observationFence: null,
        };
        if (backend === 'postgres') {
          const url = process.env.TEST_DATABASE_URL;
          if (!url) throw new Error('An allocated test database is required');
          db = createDb(url);
          await db.insert(agents).values({
            id: agentId,
            name: 'Curiosity fixture',
            email: `${agentId}@example.test`,
            workspacePrefix: agentId,
          });
          await db.insert(deviceTokens).values({
            agentId,
            token: deviceToken,
            platform: 'ios',
            environment: 'production',
          });
          const database = db;
          admit = (request) => admitPostgresCuriosityQuestion(database, request);
        } else {
          store = emulatorStore();
          await store
            .doc('agents', agentId)
            .set({ id: agentId, name: 'Owner', email: `${agentId}@example.test`, timezone: 'UTC' });
          graph = new FirestoreGraphCuriosityRepository(store, agentId);
          const deviceId = randomUUID();
          await store.doc('deviceTokens', deviceId).set({
            id: deviceId,
            agentId,
            token: deviceToken,
            platform: 'ios',
            environment: 'production',
            invalidatedAt: null,
            lastSeenAt: input.now,
          });
          const repository = graph;
          admit = (request) => repository.admitQuestion(request);
        }
      });
      afterEach(async () => {
        vi.restoreAllMocks();
        if (store) {
          await disposeStore(store);
          store = undefined;
        }
        if (db) {
          await db
            .delete(messages)
            .where(eq(messages.channelMessageId, `curiosity:${agentId}:${input.key}`));
          await db.delete(notificationOutbox).where(eq(notificationOutbox.agentId, agentId));
          await db.delete(proactivePings).where(eq(proactivePings.agentId, agentId));
          await db.delete(deviceTokens).where(eq(deviceTokens.agentId, agentId));
          await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agentId));
          await db.delete(suggestions).where(eq(suggestions.agentId, agentId));
          await db.delete(conversations).where(eq(conversations.agentId, agentId));
          await db
            .delete(maintenanceCursors)
            .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
          await db.delete(agents).where(eq(agents.id, agentId));
          await db.$client.end();
          db = undefined;
        }
      });
      async function counts() {
        if (db)
          return {
            markers: (await db.select().from(suggestions).where(eq(suggestions.agentId, agentId)))
              .length,
            notices: (
              await db
                .select()
                .from(messages)
                .where(eq(messages.channelMessageId, `curiosity:${agentId}:${input.key}`))
            ).length,
            outbox: (
              await db
                .select()
                .from(notificationOutbox)
                .where(eq(notificationOutbox.agentId, agentId))
            ).length,
            pings: (
              await db.select().from(proactivePings).where(eq(proactivePings.agentId, agentId))
            ).length,
          };
        if (!store) throw new Error('Missing store');
        return {
          markers: (await store.collection('suggestions').get()).size,
          notices: (await store.collection('messages').get()).size,
          outbox: (
            await store.collection('notificationOutbox').where('agentId', '==', agentId).get()
          ).size,
          pings: (await store.collection('proactivePings').where('agentId', '==', agentId).get())
            .size,
        };
      }
      it('rolls back a gap claim when visible notice creation fails, then recovers with fresh dependencies', async () => {
        if (db) {
          const database = db;
          const failing = new Proxy(database, {
            get(target, key, receiver) {
              if (key !== 'transaction') return Reflect.get(target, key, receiver);
              return (callback: Parameters<Db['transaction']>[0]) =>
                target.transaction((tx) =>
                  callback(
                    new Proxy(tx, {
                      get(transaction, property, transactionReceiver) {
                        if (property !== 'insert')
                          return Reflect.get(transaction, property, transactionReceiver);
                        return (table: unknown) => {
                          if (table === messages)
                            throw new Error('Injected notice failure after gap marker');
                          return transaction.insert(table as Parameters<typeof tx.insert>[0]);
                        };
                      },
                    }),
                  ),
                );
            },
          });
          await expect(admitPostgresCuriosityQuestion(failing, input)).rejects.toThrow(
            'Injected notice failure',
          );
        } else {
          const spy = vi
            .spyOn(FirestoreOwnerNoticeRepository.prototype, 'appendNoticeInTransaction')
            .mockImplementationOnce(() => {
              throw new Error('Injected notice failure after gap marker');
            });
          await expect(admit(input)).rejects.toThrow('Injected notice failure');
          spy.mockRestore();
        }
        expect(await counts()).toEqual({ markers: 0, notices: 0, outbox: 0, pings: 0 });
        if (store)
          admit = (request) =>
            new FirestoreGraphCuriosityRepository(
              store as InstallationStore,
              agentId,
            ).admitQuestion(request);
        expect(await admit(input)).toMatchObject({ status: 'posted' });
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 1, pings: 1 });
      });
      it('converges concurrent producers and survives a process loss after commit without another question', async () => {
        const outcomes = await Promise.all([admit(input), admit(input)]);
        expect(outcomes.map((r) => r.status).sort()).toEqual(['already-posted', 'posted']);
        const replay = store
          ? await new FirestoreGraphCuriosityRepository(store, agentId).admitQuestion(input)
          : await admit(input);
        expect(replay.status).toBe('already-posted');
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 1, pings: 1 });
      }, 30_000);
      it('commits per-device push intents with the question and a fresh drainer can recover them', async () => {
        const admitted = await admit(input);
        expect(admitted).toMatchObject({
          status: 'posted',
          pushAdmission: { status: 'queued', destinations: 1 },
        });
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 1, pings: 1 });

        let rows: Array<Record<string, unknown>>;
        if (db) {
          rows = (await db
            .select()
            .from(notificationOutbox)
            .where(eq(notificationOutbox.agentId, agentId))) as Array<Record<string, unknown>>;
        } else if (store) {
          const snapshot = await store
            .collection('notificationOutbox')
            .where('agentId', '==', agentId)
            .get();
          rows = snapshot.docs.map((doc) => doc.data());
        } else {
          throw new Error('Missing persistence');
        }
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ adapter: 'push', status: 'pending', attempts: 0 });
        expect(JSON.stringify(rows[0])).not.toContain(deviceToken);
        expect(rows[0]?.payload).toMatchObject({
          title: backend === 'postgres' ? 'Curiosity fixture' : 'Owner',
          body: input.question,
          category: 'ASSISTANT_UPDATE',
        });

        // Simulate a process restart: a new adapter instance sees the committed
        // intent and owns its first attempt. The callback is synthetic; no APNs
        // client or network is involved in this regression.
        let sendAttempts = 0;
        let restartedDb: Db | undefined;
        try {
          let restartedOutbox: NotificationOutboxRepository;
          if (store) {
            restartedOutbox = new FirestoreNotificationOutboxRepository(store, agentId);
          } else {
            restartedDb = createDb(process.env.TEST_DATABASE_URL as string);
            restartedOutbox = createPostgresNotificationOutboxRepository(restartedDb);
          }
          expect(
            await drainNotificationOutbox(restartedOutbox, {
              agentId,
              adapter: 'push',
              now: input.now,
              send: async () => {
                sendAttempts += 1;
                return { status: 'delivered', providerMessageId: 'synthetic-accepted' };
              },
            }),
          ).toBe(1);
          expect(sendAttempts).toBe(1);
        } finally {
          await restartedDb?.$client.end();
        }
        if (db) {
          expect(
            (
              await db
                .select()
                .from(notificationOutbox)
                .where(eq(notificationOutbox.agentId, agentId))
            )[0],
          ).toMatchObject({ status: 'delivered', attempts: 1 });
        } else if (store) {
          const delivered = await store
            .collection('notificationOutbox')
            .where('agentId', '==', agentId)
            .get();
          expect(delivered.docs[0]?.get('status')).toBe('delivered');
        }
      }, 30_000);
      it('idempotently reuses the exact ambient reservation on policy recheck', async () => {
        const admitted = await admit(input);
        expect(admitted.status).toBe('posted');
        const policy = store
          ? new FirestoreNudgePolicyRepository(store, agentId)
          : createPostgresNudgePolicyRepository(db as Db);
        const decision = await policy.evaluate(
          { id: agentId, timezone: 'UTC' },
          {
            urgency: 'ambient',
            channel: curiosityNudgeChannel(curiosityDeliveryKey(input.key)),
            now: input.now,
          },
        );
        expect(decision).toEqual({ deliver: true });
        expect(await counts()).toMatchObject({ pings: 1, outbox: 1 });
      });
      it('keeps an ambiguous push attempt unknown and never retries it automatically', async () => {
        expect((await admit(input)).status).toBe('posted');
        let attempts = 0;
        let restartedDb: Db | undefined;
        try {
          let restartedOutbox: NotificationOutboxRepository;
          if (store) {
            restartedOutbox = new FirestoreNotificationOutboxRepository(store, agentId);
          } else {
            restartedDb = createDb(process.env.TEST_DATABASE_URL as string);
            restartedOutbox = createPostgresNotificationOutboxRepository(restartedDb);
          }
          const send = async () => {
            attempts += 1;
            return { status: 'unknown' as const, reason: 'provider-outcome-unknown' };
          };
          await drainNotificationOutbox(restartedOutbox, {
            agentId,
            adapter: 'push',
            now: input.now,
            send,
          });
          await drainNotificationOutbox(restartedOutbox, {
            agentId,
            adapter: 'push',
            now: new Date(input.now.getTime() + 5 * 60_000),
            send,
          });
          expect(attempts).toBe(1);
          if (restartedDb) {
            expect(
              (
                await restartedDb
                  .select()
                  .from(notificationOutbox)
                  .where(eq(notificationOutbox.agentId, agentId))
              )[0],
            ).toMatchObject({ status: 'unknown', attempts: 1, retryable: false });
          } else if (store) {
            const snapshot = await store
              .collection('notificationOutbox')
              .where('agentId', '==', agentId)
              .get();
            expect(snapshot.docs[0]?.data()).toMatchObject({
              status: 'unknown',
              attempts: 1,
              retryable: false,
            });
          }
        } finally {
          await restartedDb?.$client.end();
        }
      }, 30_000);
      it('records quiet-hours or a reached daily cap in the same admission and queues no push intent', async () => {
        if (db) {
          await db.insert(notificationPrefs).values({
            agentId,
            quietStartMin: 600,
            quietEndMin: 780,
            ambientDailyCap: null,
          });
        } else if (store) {
          await store.doc('notificationPrefs', agentId).set({
            agentId,
            quietStartMin: 600,
            quietEndMin: 780,
            ambientDailyCap: null,
          });
        }
        const quiet = await admit(input);
        expect(quiet).toMatchObject({
          status: 'posted',
          pushAdmission: { status: 'held', reason: 'quiet-hours' },
        });
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 0, pings: 1 });
      });
      it('reserves the last owner-local ambient slot atomically with the question', async () => {
        if (db) {
          await db.insert(notificationPrefs).values({
            agentId,
            quietStartMin: null,
            quietEndMin: null,
            ambientDailyCap: 1,
          });
          await db.insert(proactivePings).values({
            agentId,
            urgency: 'ambient',
            channel: 'already-used',
            delivered: true,
            createdAt: input.now,
          });
        } else if (store) {
          await store.doc('notificationPrefs', agentId).set({
            agentId,
            quietStartMin: null,
            quietEndMin: null,
            ambientDailyCap: 1,
          });
          const usedId = randomUUID();
          await store.doc('proactivePings', usedId).set({
            id: usedId,
            agentId,
            urgency: 'ambient',
            channel: 'already-used',
            delivered: true,
            reason: null,
            createdAt: input.now,
          });
        }
        const admitted = await admit(input);
        expect(admitted).toMatchObject({
          status: 'posted',
          pushAdmission: { status: 'held', reason: 'daily-cap' },
        });
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 0, pings: 2 });
      });
      it('abstains from a partial fan-out when the bounded device scan overflows', async () => {
        if (db) {
          await db.insert(deviceTokens).values(
            Array.from({ length: 100 }, (_, index) => ({
              agentId,
              token: `${deviceToken}-${index}`,
              platform: 'ios',
              environment: 'production',
            })),
          );
        } else if (store) {
          await Promise.all(
            Array.from({ length: 100 }, async (_, index) => {
              const id = randomUUID();
              await store?.doc('deviceTokens', id).set({
                id,
                agentId,
                token: `${deviceToken}-${index}`,
                platform: 'ios',
                environment: 'production',
                invalidatedAt: null,
                lastSeenAt: input.now,
              });
            }),
          );
        }
        const admitted = await admit(input);
        expect(admitted).toMatchObject({
          status: 'posted',
          pushAdmission: { status: 'unknown', reason: 'device-list-overflow' },
        });
        expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 0, pings: 1 });
      });
      it.skipIf(backend !== 'firestore')(
        'abstains from push delivery when a registered Firestore target is malformed',
        async () => {
          if (!store) throw new Error('Firestore fixture is unavailable');
          const malformedId = randomUUID();
          await store.doc('deviceTokens', malformedId).set({
            id: malformedId,
            agentId,
            token: `bad-${randomUUID()}`,
            platform: 'ios',
            environment: 'unknown',
            invalidatedAt: null,
            lastSeenAt: input.now,
          });
          expect(await admit(input)).toMatchObject({
            status: 'posted',
            pushAdmission: { status: 'unknown', reason: 'malformed-device-registry' },
          });
          expect(await counts()).toEqual({ markers: 1, notices: 1, outbox: 0, pings: 1 });
        },
      );
      it('rejects an observation started before a completed privacy erase', async () => {
        if (db)
          await db
            .insert(maintenanceCursors)
            .values({ name: `privacy-erasure-generation:${agentId}`, cursor: randomUUID() });
        else if (store)
          await store
            .doc('privacyErasureJobs', agentId)
            .set({ agentId, status: 'complete', generation: randomUUID() });
        await expect(admit(input)).rejects.toThrow('changed during curiosity observation');
        expect(await counts()).toEqual({ markers: 0, notices: 0, outbox: 0, pings: 0 });
      });
      it('keeps a legacy marker without a verified notice receipt explicitly unknown', async () => {
        const row = {
          id: randomUUID(),
          agentId,
          sourceRef: input.key,
          summary: input.question,
          proposedAction: 'Nothing to run',
          origin: 'curiosity',
          status: 'dismissed',
          expiresAt: new Date(Date.now() + 86_400_000),
        };
        if (db) await db.insert(suggestions).values(row);
        else if (store) await store.doc('suggestions', row.id).set(row);
        expect(await admit(input)).toEqual({ status: 'legacy-unknown' });
        expect(await counts()).toEqual({ markers: 1, notices: 0, outbox: 0, pings: 0 });
      });
    },
  );
}
