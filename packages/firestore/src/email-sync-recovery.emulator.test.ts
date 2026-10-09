import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!HOST)('Firestore direct email recovery persistence', () => {
  let store: InstallationStore | undefined;
  afterEach(async () => {
    if (store) await disposeStore(store);
    store = undefined;
  });

  it('scans only bounded unadmitted direct metadata and terminalizes a missing provider source', async () => {
    const agentId = randomUUID();
    store = emulatorStore();
    await store
      .doc('agents', agentId)
      .set({ id: agentId, email: 'owner@example.test', name: 'Owner' });
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    const result = await repository.withLock(async (lease) => {
      const makeIngest = async (messageId: string) =>
        repository.beginDirectEmailIngest(
          {
            agentId,
            mailbox: 'owner@example.test',
            providerMessageId: messageId,
            providerThreadId: 'thread-1',
            sourceMessageId: `<${messageId}@example.test>`,
            channelMessageId: `gmail:${messageId}`,
            conversationId: null,
            fromEmail: 'sender@example.test',
            fromName: null,
            subject: 'Recovery source',
            contentTrust: 'unknown',
            authenticated: true,
            ingestMode: 'direct',
            hasExternalOrUnknown: true,
            category: 'other',
            importance: 1,
            actionable: false,
            reason: '',
            dates: [],
          },
          { expectedPrivacyGeneration: null, lease },
        );
      for (let index = 0; index < 21; index++) await makeIngest(`recover-${index}`);
      const rows = await repository.listRecoverableDirectIngests({
        agentId,
        mailbox: 'owner@example.test',
        expectedPrivacyGeneration: null,
        lease,
        limit: 99,
      });
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((row) => row.id)).size).toBe(20);
      const target = rows[0]!;
      expect(target).toMatchObject({
        authenticated: true,
        providerMessageId: expect.any(String),
        providerThreadId: 'thread-1',
        admittedSourceKind: null,
        admittedSourceId: null,
        messagePersisted: false,
        classificationStatus: 'pending',
        scoreStatus: 'pending',
      });
      expect(target).not.toHaveProperty('body');
      expect(target).not.toHaveProperty('rawHeaders');
      expect(
        await repository.markDirectIngestRecoveryUnavailable({
          agentId,
          mailbox: 'owner@example.test',
          ingestId: target.id,
          expectedPrivacyGeneration: null,
          lease,
          reason: 'provider_message_missing',
        }),
      ).toBe(true);
      const nextPage = await repository.listRecoverableDirectIngests({
        agentId,
        mailbox: 'owner@example.test',
        expectedPrivacyGeneration: null,
        lease,
        limit: 99,
      });
      expect(nextPage).toHaveLength(20);
      expect(nextPage.some((row) => row.id === target.id)).toBe(false);
      const stored = await store!.doc('emailIngest', target.id).get();
      expect(stored.get('pipelineStage')).toBe('needs_attention');
      expect(stored.get('directRouting')).toBe('needs_attention');
      expect(stored.get('directRecoveryReason')).toBe('provider_message_missing');
    });
    expect(result?.value).toBeUndefined();
  });

  it('rejects a superseded mailbox lease without changing a pending checkpoint', async () => {
    const agentId = randomUUID();
    store = emulatorStore();
    await store
      .doc('agents', agentId)
      .set({ id: agentId, email: 'owner@example.test', name: 'Owner' });
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    await repository.withLock(async (lease) => {
      const ingest = await repository.beginDirectEmailIngest(
        {
          agentId,
          mailbox: 'owner@example.test',
          providerMessageId: 'recover-stale-lease',
          channelMessageId: 'gmail:recover-stale-lease',
          conversationId: null,
          fromEmail: 'sender@example.test',
          fromName: null,
          subject: 'Recovery source',
          contentTrust: 'unknown',
          authenticated: true,
          ingestMode: 'direct',
          hasExternalOrUnknown: true,
          category: 'other',
          importance: 1,
          actionable: false,
          reason: '',
          dates: [],
        },
        { expectedPrivacyGeneration: null, lease },
      );
      await store!.doc('coordination', 'gmail-sync-lock').set({
        holder: 'replacement-worker',
        generation: lease.generation + 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        repository.listRecoverableDirectIngests({
          agentId,
          mailbox: 'owner@example.test',
          expectedPrivacyGeneration: null,
          lease,
          limit: 20,
        }),
      ).rejects.toThrow('lease is no longer current');
      const source = await store!.doc('emailIngest', ingest.id).get();
      expect(source.get('pipelineStage')).toBe('pending_classification');
      expect(source.get('directRecoveryReason')).toBeNull();
    });
  });

  it('rejects a stale captured privacy generation before returning scan metadata', async () => {
    const agentId = randomUUID();
    store = emulatorStore();
    await store
      .doc('agents', agentId)
      .set({ id: agentId, email: 'owner@example.test', name: 'Owner' });
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    await repository.withLock(async (lease) => {
      await repository.beginDirectEmailIngest(
        {
          agentId,
          mailbox: 'owner@example.test',
          providerMessageId: 'recover-2',
          channelMessageId: 'gmail:recover-2',
          conversationId: null,
          fromEmail: 'sender@example.test',
          fromName: null,
          subject: 'Recovery source',
          contentTrust: 'unknown',
          authenticated: true,
          ingestMode: 'direct',
          hasExternalOrUnknown: true,
          category: 'other',
          importance: 1,
          actionable: false,
          reason: '',
          dates: [],
        },
        { expectedPrivacyGeneration: null, lease },
      );
      await store!.doc('privacyErasureJobs', agentId).set({
        id: agentId,
        agentId,
        status: 'complete',
        generation: 'new-generation',
        version: 2,
      });
      await expect(
        repository.listRecoverableDirectIngests({
          agentId,
          mailbox: 'owner@example.test',
          expectedPrivacyGeneration: null,
          lease,
          limit: 20,
        }),
      ).rejects.toThrow('Privacy erasure changed');
    });
  });

  it('keeps fresh direct work visible beyond a disabled paid-observer backlog at the normal limit', async () => {
    const agentId = randomUUID();
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId, email: 'owner@example.test' });
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    const now = new Date();
    const makeWork = (
      id: string,
      observerKey: string,
      observerVersion: number,
      workClass: Records['emailObserverWork']['workClass'],
      createdAt: Date,
    ): Records['emailObserverWork'] => ({
      id,
      agentId,
      sourceKey: id,
      channelMessageId: `gmail:${id}`,
      sourceKind: 'automated_source',
      observerKey,
      observerVersion,
      workClass,
      status: 'pending',
      attemptCount: 0,
      claimToken: null,
      claimGeneration: 0,
      leaseExpiresAt: null,
      privacyGeneration: null,
      budgetKey: null,
      budgetWindowStart: null,
      budgetReserved: false,
      preparedResult: null,
      deliveryKey: null,
      lastErrorCode: null,
      claimedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: now,
    });
    const disabled = Array.from({ length: 25 }, (_, index) =>
      makeWork(
        randomUUID(),
        'google.email-card',
        1,
        'paid_ambiguous',
        new Date(now.getTime() + index),
      ),
    );
    const newerVersion = makeWork(
      randomUUID(),
      'google.email-card',
      2,
      'paid_ambiguous',
      new Date(now.getTime() + 90),
    );
    const otherWorkClass = makeWork(
      randomUUID(),
      'google.email-card',
      1,
      'idempotent_db',
      new Date(now.getTime() + 80),
    );
    const direct = makeWork(
      randomUUID(),
      'google.direct-email-routing',
      1,
      'idempotent_db',
      new Date(now.getTime() + 100),
    );
    for (const row of [...disabled, otherWorkClass, newerVersion, direct])
      await store.doc('emailObserverWork', row.id).set(encodeRecord(row));

    const due = await repository.listDueEmailObservers(agentId, now, 20, [
      { key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' },
    ]);

    expect(due.map(({ id }) => id)).toEqual([otherWorkClass.id, newerVersion.id, direct.id]);
    expect(due.some(({ id }) => disabled.some((row) => row.id === id))).toBe(false);
  });
});
