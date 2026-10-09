import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { notificationDashboardMessageId } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreNotificationOutboxRepository } from './notification-outbox.js';
import type { InstallationStore } from './store.js';
import { decodeRecord, encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore notification outbox', () => {
  let store: InstallationStore;
  let ownerId: string;
  let repository: FirestoreNotificationOutboxRepository;
  let currentTime = new Date();
  beforeEach(async () => {
    currentTime = new Date();
    store = emulatorStore(() => currentTime);
    ownerId = randomUUID();
    await store.doc('agents', ownerId).set({ id: ownerId, name: 'Outbox test' });
    repository = new FirestoreNotificationOutboxRepository(store, ownerId);
  });
  afterEach(async () => disposeStore(store));

  it('owner-fences claims, retries only definitive failures, and turns expired claims into unknown', async () => {
    const now = store.now();
    const preparation = {
      agentId: ownerId,
      deliveryKey: 'producer:stable-key',
      legKey: 'push:device-a',
      adapter: 'push',
      destination: { deviceKey: 'opaque-device-key' },
      payload: { body: 'Frozen owner message' },
      now,
    };
    const [prepared, replay] = await Promise.all([
      repository.prepare(preparation),
      repository.prepare(preparation),
    ]);
    expect(prepared.id).toBe(replay.id);
    const claims = await Promise.all([
      repository.claim({ agentId: ownerId, legId: prepared.id, now, leaseMs: 30_000 }),
      repository.claim({ agentId: ownerId, legId: prepared.id, now, leaseMs: 30_000 }),
    ]);
    const claimed = claims.filter((value) => value !== null);
    expect(claimed).toHaveLength(1);
    const claim = claimed[0];
    if (!claim?.leaseToken) throw new Error('Outbox claim omitted its lease token');
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: claim.id,
        leaseToken: claim.leaseToken,
        status: 'failed',
        retryable: true,
        retryAt: new Date(now.getTime() + 5_000),
        now,
      }),
    ).toBe(true);
    expect(
      await repository.claim({
        agentId: ownerId,
        legId: claim.id,
        now: new Date(now.getTime() + 4_999),
        leaseMs: 30_000,
      }),
    ).toBeNull();
    currentTime = new Date(now.getTime() + 5_000);
    const retried = await repository.claim({
      agentId: ownerId,
      legId: claim.id,
      now: new Date(now.getTime() + 5_000),
      leaseMs: 30_000,
    });
    if (!retried?.leaseToken) throw new Error('Retryable delivery did not become claimable');
    expect(retried.attempts).toBe(2);
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: retried.id,
        leaseToken: retried.leaseToken,
        status: 'unknown',
        now: new Date(now.getTime() + 5_000),
      }),
    ).toBe(true);
    await expect(repository.pending(randomUUID())).rejects.toThrow('outside the owner');
    await expect(
      repository.claim({ agentId: randomUUID(), legId: prepared.id, now, leaseMs: 30_000 }),
    ).rejects.toThrow('outside the owner');

    currentTime = now;
    const abandoned = await repository.prepare({
      ...preparation,
      deliveryKey: 'producer:abandoned',
      legKey: 'dashboard',
    });
    expect(
      await repository.claim({ agentId: ownerId, legId: abandoned.id, now, leaseMs: 1_000 }),
    ).not.toBeNull();
    currentTime = new Date(now.getTime() + 1_001);
    expect(await repository.recoverExpired(ownerId, currentTime)).toBe(1);
    expect(
      await repository.claim({ agentId: ownerId, legId: abandoned.id, now, leaseMs: 10_000 }),
    ).toBeNull();
  });

  it('allows delayed drain after observer completion and scrubs an erased prepared leg', async () => {
    const now = store.now();
    const work = (id: string): Records['emailObserverWork'] => ({
      id,
      agentId: ownerId,
      sourceKey: `source-${id}`,
      channelMessageId: `gmail:${id}`,
      sourceKind: 'message',
      observerKey: 'google.email-card',
      observerVersion: 1,
      workClass: 'paid_ambiguous',
      status: 'prepared',
      attemptCount: 1,
      claimToken: `token-${id}`,
      claimGeneration: 1,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      privacyGeneration: null,
      budgetKey: null,
      budgetWindowStart: null,
      budgetReserved: false,
      preparedResult: { kind: 'prepared' },
      deliveryKey: `work-delivery-${id}`,
      lastErrorCode: null,
      claimedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const id of ['work-valid', 'work-erased']) {
      const row = work(id);
      await store.doc('emailObserverWork', id).set(encodeRecord(row));
      const fence = {
        id,
        agentId: ownerId,
        claimToken: row.claimToken!,
        claimGeneration: 1,
        expectedPrivacyGeneration: null,
      };
      const prepared = await repository.prepare({
        agentId: ownerId,
        deliveryKey: `notice-${id}`,
        legKey: 'dashboard',
        adapter: 'dashboard',
        destination: { conversationId: 'conversation-1' },
        payload: { text: 'Saved card', extraParts: [] },
        now,
        emailObserverEffectFence: fence,
      });
      if (id === 'work-valid') {
        await store
          .doc('emailObserverWork', id)
          .update({ status: 'complete', claimToken: null, leaseExpiresAt: null });
        const claimed = await repository.claim({
          agentId: ownerId,
          legId: prepared.id,
          now: new Date(now.getTime() + 120_000),
          leaseMs: 30_000,
        });
        expect(claimed?.status).toBe('sending');
        expect(claimed?.producerWorkId).toBe(id);
      } else {
        await store.doc('emailObserverWork', id).update({
          status: 'skipped_erased',
          claimToken: null,
          leaseExpiresAt: null,
          privacyGeneration: 'privacy-next',
        });
        const rejected = await repository.claim({
          agentId: ownerId,
          legId: prepared.id,
          now: new Date(now.getTime() + 1),
          leaseMs: 30_000,
        });
        expect(rejected?.status).toBe('skipped');
        expect(rejected?.destination).toBeNull();
        expect(rejected?.payload).toBeNull();
        expect(rejected?.attempts).toBe(0);
      }
    }
  });

  it('rechecks the observer lease after its Firestore read', async () => {
    const workId = 'observer-clock-fence';
    const before = currentTime;
    const work: Records['emailObserverWork'] = {
      id: workId,
      agentId: ownerId,
      sourceKey: `source-${workId}`,
      channelMessageId: `gmail:${workId}`,
      sourceKind: 'message',
      observerKey: 'google.email-card',
      observerVersion: 1,
      workClass: 'paid_ambiguous',
      status: 'prepared',
      attemptCount: 1,
      claimToken: 'claim-expiring',
      claimGeneration: 2,
      leaseExpiresAt: new Date(before.getTime() + 500),
      privacyGeneration: null,
      budgetKey: null,
      budgetWindowStart: null,
      budgetReserved: false,
      preparedResult: { kind: 'prepared' },
      deliveryKey: `work-delivery-${workId}`,
      lastErrorCode: null,
      claimedAt: before,
      completedAt: null,
      createdAt: before,
      updatedAt: before,
    };
    await store.doc('emailObserverWork', workId).set(encodeRecord(work));
    const fence = {
      id: workId,
      agentId: ownerId,
      claimToken: 'claim-expiring',
      claimGeneration: 2,
      expectedPrivacyGeneration: null,
    };
    const originalDb = store.db;
    const runTransaction = originalDb.runTransaction.bind(originalDb);
    let advanced = false;
    const delayedDb = new Proxy(originalDb, {
      get(target, property) {
        if (property !== 'runTransaction') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (callback: (transaction: object) => Promise<unknown>, options?: unknown) =>
          runTransaction(async (transaction) => {
            const delayedTransaction = new Proxy(transaction, {
              get(tx, name) {
                const value = Reflect.get(tx, name, tx);
                if (name !== 'get' || typeof value !== 'function')
                  return typeof value === 'function' ? value.bind(tx) : value;
                return async (reference: { path?: string } | unknown) => {
                  const snapshot = await value.call(tx, reference);
                  if (
                    !advanced &&
                    (reference as { path?: string }).path ===
                      store.doc('emailObserverWork', workId).path
                  ) {
                    advanced = true;
                    currentTime = new Date(before.getTime() + 501);
                  }
                  return snapshot;
                };
              },
            });
            return callback(delayedTransaction);
          }, options as never);
      },
    }) as typeof originalDb;
    Object.defineProperty(store, 'db', { value: delayedDb, configurable: true });
    try {
      await expect(
        repository.prepare({
          agentId: ownerId,
          deliveryKey: 'expired-prepare',
          legKey: 'dashboard',
          adapter: 'dashboard',
          destination: { conversationId: 'unused' },
          payload: { text: 'Saved card', extraParts: [] },
          now: before,
          emailObserverEffectFence: fence,
        }),
      ).rejects.toThrow('fence is stale');
      expect(advanced).toBe(true);
    } finally {
      Object.defineProperty(store, 'db', { value: originalDb, configurable: true });
      await store.doc('emailObserverWork', workId).delete();
    }
  });

  it('binds dashboard append, replays a crash safely, and erases its derived message', async () => {
    const now = currentTime;
    const conversationId = 'owner-notifications';
    await store.doc('conversations', conversationId).set({
      id: conversationId,
      agentId: ownerId,
      channel: 'chat',
      trust: 'assistant',
      title: 'Notifications',
    });
    const workId = 'dashboard-notice-work';
    const work: Records['emailObserverWork'] = {
      id: workId,
      agentId: ownerId,
      sourceKey: `source-${workId}`,
      channelMessageId: `gmail:${workId}`,
      sourceKind: 'message',
      observerKey: 'google.email-card',
      observerVersion: 1,
      workClass: 'paid_ambiguous',
      status: 'prepared',
      attemptCount: 1,
      claimToken: 'observer-token',
      claimGeneration: 4,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      privacyGeneration: null,
      budgetKey: null,
      budgetWindowStart: null,
      budgetReserved: false,
      preparedResult: { kind: 'prepared' },
      deliveryKey: `work-delivery-${workId}`,
      lastErrorCode: null,
      claimedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.doc('emailObserverWork', workId).set(encodeRecord(work));
    const fence = {
      id: workId,
      agentId: ownerId,
      claimToken: 'observer-token',
      claimGeneration: 4,
      expectedPrivacyGeneration: null,
    };
    const prepared = await repository.prepare({
      agentId: ownerId,
      deliveryKey: 'dashboard-notice',
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId },
      payload: { text: 'Saved card', extraParts: [] },
      now,
      emailObserverEffectFence: fence,
    });
    await store
      .doc('emailObserverWork', workId)
      .update({ status: 'complete', claimToken: null, leaseExpiresAt: null });

    const availableAt = new Date(now.getTime() + 500);
    await store.doc('notificationOutbox', prepared.id).update({ availableAt });
    let advanced = false;
    const originalDb = store.db;
    const runTransaction = originalDb.runTransaction.bind(originalDb);
    const delayedDb = new Proxy(originalDb, {
      get(target, property) {
        if (property !== 'runTransaction') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (callback: (transaction: object) => Promise<unknown>, options?: unknown) =>
          runTransaction(async (transaction) => {
            const delayedTransaction = new Proxy(transaction, {
              get(tx, name) {
                const value = Reflect.get(tx, name, tx);
                if (name !== 'get' || typeof value !== 'function')
                  return typeof value === 'function' ? value.bind(tx) : value;
                return async (reference: { path?: string } | unknown) => {
                  const snapshot = await value.call(tx, reference);
                  if (
                    !advanced &&
                    (reference as { path?: string }).path ===
                      store.doc('notificationOutbox', prepared.id).path
                  ) {
                    advanced = true;
                    currentTime = new Date(availableAt.getTime() + 1);
                  }
                  return snapshot;
                };
              },
            });
            return callback(delayedTransaction);
          }, options as never);
      },
    }) as typeof originalDb;
    Object.defineProperty(store, 'db', { value: delayedDb, configurable: true });
    const claimed = await repository.claim({
      agentId: ownerId,
      legId: prepared.id,
      now,
      leaseMs: 1_000,
    });
    Object.defineProperty(store, 'db', { value: originalDb, configurable: true });
    expect(advanced).toBe(true);
    expect(claimed?.status).toBe('sending');
    if (!claimed?.leaseToken) throw new Error('Dashboard claim omitted lease token');

    const channelMessageId = notificationDashboardMessageId(
      ownerId,
      prepared.deliveryKey,
      prepared.legKey,
    );
    const messages = new FirestoreMessageRepository(store);
    const appendInput = {
      conversationId,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: [{ type: 'text', text: 'Saved card' }],
      text: 'Saved card',
      channelMessageId,
      notificationOutboxFence: {
        agentId: ownerId,
        legId: claimed.id,
        leaseToken: claimed.leaseToken,
        producerWorkId: workId,
        producerPrivacyGeneration: null,
      },
    };
    await expect(
      messages.append({
        ...appendInput,
        text: 'Tampered',
        parts: [{ type: 'text', text: 'Tampered' }],
      }),
    ).rejects.toThrow('fence');
    expect(await messages.append(appendInput)).toBeDefined();
    expect(await messages.append(appendInput)).toBeUndefined();

    currentTime = new Date(claimed.leaseUntil!.getTime() + 1);
    expect(await repository.recoverExpired(ownerId, currentTime)).toBe(1);
    const replay = await repository.claim({
      agentId: ownerId,
      legId: claimed.id,
      now: new Date(0),
      leaseMs: 60_000,
    });
    if (!replay?.leaseToken) throw new Error('Dashboard append did not become safely replayable');
    expect(
      await messages.append({
        ...appendInput,
        notificationOutboxFence: {
          ...appendInput.notificationOutboxFence,
          leaseToken: replay.leaseToken,
        },
      }),
    ).toBeUndefined();
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: replay.id,
        leaseToken: replay.leaseToken,
        status: 'delivered',
        now: currentTime,
      }),
    ).toBe(true);
    expect(
      (await store.collection('messages').where('channelMessageId', '==', channelMessageId).get())
        .size,
    ).toBe(1);

    await new FirestoreEmailSyncRepository(store, ownerId).eraseEmailObserverData(
      ownerId,
      'privacy-next',
      currentTime,
    );
    const postEraseMessages = await store
      .collection('messages')
      .where('channelMessageId', '==', channelMessageId)
      .get();
    expect(postEraseMessages.size).toBe(0);
    expect((await store.doc('messageChannelIds', channelMessageId).get()).exists).toBe(false);
    const erasedSnapshot = await store.doc('notificationOutbox', replay.id).get();
    const erased = decodeRecord<Records['notificationOutbox']>(erasedSnapshot.data());
    expect(erased.payload).toBeNull();
    expect(erased.destination).toBeNull();
  });
});
