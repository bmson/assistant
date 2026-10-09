import { randomUUID } from 'node:crypto';
import type {
  ApplicationConfirmationNoticeFence,
  EmailObserverEffectFence,
  NotificationOutboxLeg,
  NotificationOutboxRepository,
  Records,
} from '@assistant/persistence';
import {
  matchesApplicationConfirmationNoticeLineage,
  matchesPreparedEmailObserverClaim,
  notificationOutboxLegId,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import {
  assertPrivacyErasureGenerationInTransaction,
  assertPrivacyErasureInactiveInTransaction,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return item;
  };
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new Error('notification payload must be JSON data');
  return encoded;
}

function assertPreparation(input: Parameters<NotificationOutboxRepository['prepare']>[0]) {
  for (const [name, value] of Object.entries({
    agentId: input.agentId,
    deliveryKey: input.deliveryKey,
    legKey: input.legKey,
    adapter: input.adapter,
  })) {
    if (!value.trim()) throw new Error(`notification outbox ${name} is required`);
  }
  canonical(input.destination);
  canonical(input.payload);
}

/** Firestore outbox mirrors the SQL owner, lease, and erasure fences. */
export class FirestoreNotificationOutboxRepository implements NotificationOutboxRepository {
  readonly kind = 'notification-outbox-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private async owner(tx: Transaction, agentId: string): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Notification outbox is outside the owner');
    const ref = this.store.doc('agents', agentId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.get('id') !== agentId || snapshot.id !== documentKey(agentId))
      throw new Error('Notification outbox owner is unavailable');
    await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
  }

  private async preparedFence(
    tx: Transaction,
    input: Parameters<NotificationOutboxRepository['prepare']>[0],
    fence: EmailObserverEffectFence,
  ): Promise<boolean> {
    if (fence.agentId !== input.agentId) return false;
    await assertPrivacyErasureGenerationInTransaction(
      tx,
      this.store,
      input.agentId,
      fence.expectedPrivacyGeneration,
    );
    const snapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
    const row = snapshot.exists
      ? decodeRecord<Records['emailObserverWork']>(snapshot.data())
      : null;
    // Sample after the observer read so transaction contention cannot preserve
    // a stale caller timestamp across the worker lease boundary.
    return matchesPreparedEmailObserverClaim(row, fence, this.store.now());
  }

  private async preparedApplicationNoticeFence(
    tx: Transaction,
    input: Parameters<NotificationOutboxRepository['prepare']>[0],
    fence: ApplicationConfirmationNoticeFence,
  ): Promise<boolean> {
    if (fence.agentId !== input.agentId) return false;
    await assertPrivacyErasureGenerationInTransaction(
      tx,
      this.store,
      input.agentId,
      fence.producerPrivacyGeneration,
    );
    const [taskSnapshot, applicationSnapshot] = await tx.getAll(
      this.store.doc('tasks', fence.taskId),
      this.store.doc('applicationConfirmations', fence.applicationId),
    );
    const task = taskSnapshot?.exists ? decodeRecord<Records['tasks']>(taskSnapshot.data()) : null;
    const application = applicationSnapshot?.exists
      ? decodeRecord<Records['applicationConfirmations']>(applicationSnapshot.data())
      : null;
    return matchesApplicationConfirmationNoticeLineage(task, application, fence, {
      now: this.store.now(),
      requireLiveTaskLease: true,
    });
  }

  private async persistedFenceIsCurrent(
    tx: Transaction,
    row: NotificationOutboxLeg,
  ): Promise<boolean> {
    if (row.producerWorkId && row.producerTaskId) return false;
    const generation = row.producerPrivacyGeneration ?? null;
    try {
      await assertPrivacyErasureGenerationInTransaction(tx, this.store, row.agentId, generation);
    } catch {
      return false;
    }
    if (row.producerTaskId) {
      if (!row.producerApplicationId || !row.producerConfirmationMessageId) return false;
      const [taskSnapshot, applicationSnapshot] = await tx.getAll(
        this.store.doc('tasks', row.producerTaskId),
        this.store.doc('applicationConfirmations', row.producerApplicationId),
      );
      const task = taskSnapshot?.exists
        ? decodeRecord<Records['tasks']>(taskSnapshot.data())
        : null;
      const application = applicationSnapshot?.exists
        ? decodeRecord<Records['applicationConfirmations']>(applicationSnapshot.data())
        : null;
      return matchesApplicationConfirmationNoticeLineage(
        task,
        application,
        {
          agentId: row.agentId,
          taskId: row.producerTaskId,
          taskLeaseToken: '',
          taskQueueGeneration: -1,
          applicationId: row.producerApplicationId,
          confirmationMessageId: row.producerConfirmationMessageId,
          producerPrivacyGeneration: generation,
        },
        { now: this.store.now(), requireLiveTaskLease: false },
      );
    }
    if (!row.producerWorkId) return true;
    const snapshot = await tx.get(this.store.doc('emailObserverWork', row.producerWorkId));
    if (!snapshot.exists) return false;
    const work = decodeRecord<Records['emailObserverWork']>(snapshot.data());
    return (
      work.agentId === row.agentId &&
      work.privacyGeneration === generation &&
      work.status !== 'skipped_erased'
    );
  }

  async prepare(input: Parameters<NotificationOutboxRepository['prepare']>[0]) {
    assertPreparation(input);
    const id = notificationOutboxLegId(input.agentId, input.deliveryKey, input.legKey);
    const ref = this.store.doc('notificationOutbox', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx, input.agentId);
      if (input.emailObserverEffectFence && input.applicationConfirmationNoticeFence)
        throw new Error('Notification outbox accepts one producer fence');
      if (
        input.emailObserverEffectFence &&
        !(await this.preparedFence(tx, input, input.emailObserverEffectFence))
      )
        throw new Error('Email observer notification prepare fence is stale');
      if (
        input.applicationConfirmationNoticeFence &&
        !(await this.preparedApplicationNoticeFence(
          tx,
          input,
          input.applicationConfirmationNoticeFence,
        ))
      )
        throw new Error('Application confirmation notification prepare fence is stale');
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const existing = decodeRecord<NotificationOutboxLeg>(snapshot.data());
        if (
          existing.agentId !== input.agentId ||
          documentKey(existing.id) !== snapshot.id ||
          existing.deliveryKey !== input.deliveryKey ||
          existing.legKey !== input.legKey ||
          existing.adapter !== input.adapter ||
          (existing.producerWorkId ?? null) !== (input.emailObserverEffectFence?.id ?? null) ||
          (existing.producerTaskId ?? null) !==
            (input.applicationConfirmationNoticeFence?.taskId ?? null) ||
          (existing.producerApplicationId ?? null) !==
            (input.applicationConfirmationNoticeFence?.applicationId ?? null) ||
          (existing.producerConfirmationMessageId ?? null) !==
            (input.applicationConfirmationNoticeFence?.confirmationMessageId ?? null) ||
          (existing.producerPrivacyGeneration ?? null) !==
            (input.emailObserverEffectFence?.expectedPrivacyGeneration ??
              input.applicationConfirmationNoticeFence?.producerPrivacyGeneration ??
              null) ||
          (existing.destination !== null &&
            canonical(existing.destination) !== canonical(input.destination)) ||
          (existing.payload !== null && canonical(existing.payload) !== canonical(input.payload))
        )
          throw new Error('notification delivery identity reused with a different frozen intent');
        return existing;
      }
      const row: NotificationOutboxLeg = {
        id,
        agentId: input.agentId,
        deliveryKey: input.deliveryKey,
        legKey: input.legKey,
        adapter: input.adapter,
        status: 'pending',
        destination: input.destination,
        payload: input.payload,
        attempts: 0,
        retryable: false,
        availableAt: input.now,
        leaseToken: null,
        leaseUntil: null,
        providerMessageId: null,
        result: null,
        producerWorkId: input.emailObserverEffectFence?.id ?? null,
        producerTaskId: input.applicationConfirmationNoticeFence?.taskId ?? null,
        producerApplicationId: input.applicationConfirmationNoticeFence?.applicationId ?? null,
        producerConfirmationMessageId:
          input.applicationConfirmationNoticeFence?.confirmationMessageId ?? null,
        producerPrivacyGeneration:
          input.emailObserverEffectFence?.expectedPrivacyGeneration ??
          input.applicationConfirmationNoticeFence?.producerPrivacyGeneration ??
          null,
        finishedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      tx.create(ref, encodeRecord(row));
      return row;
    });
  }

  async claim(input: Parameters<NotificationOutboxRepository['claim']>[0]) {
    const ref = this.store.doc('notificationOutbox', input.legId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<NotificationOutboxLeg>(snapshot.data());
      if (
        row.agentId !== input.agentId ||
        documentKey(row.id) !== snapshot.id ||
        !(row.status === 'pending' || (row.status === 'failed' && row.retryable))
      )
        return null;
      const producerCurrent = await this.persistedFenceIsCurrent(tx, row);
      // Sample after the outbox, erasure-generation and producer documents are read.
      const now = this.store.now();
      if (row.availableAt.getTime() > now.getTime()) return null;
      if (!producerCurrent) {
        const scrubbed: NotificationOutboxLeg = {
          ...row,
          status: 'skipped',
          retryable: false,
          destination: null,
          payload: null,
          leaseToken: null,
          leaseUntil: null,
          result: { reason: 'email-observer-fence-invalid' },
          finishedAt: now,
          updatedAt: now,
        };
        tx.update(ref, encodeRecord(scrubbed));
        return scrubbed;
      }
      const claimed: NotificationOutboxLeg = {
        ...row,
        status: 'sending',
        attempts: row.attempts + 1,
        retryable: false,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + Math.max(1000, input.leaseMs)),
        updatedAt: now,
      };
      tx.update(ref, encodeRecord(claimed));
      return claimed;
    });
  }

  async complete(input: Parameters<NotificationOutboxRepository['complete']>[0]) {
    const ref = this.store.doc('notificationOutbox', input.legId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<NotificationOutboxLeg>(snapshot.data());
      if (
        row.agentId !== input.agentId ||
        documentKey(row.id) !== snapshot.id ||
        row.status !== 'sending' ||
        row.leaseToken !== input.leaseToken
      )
        return false;
      const retryable = input.status === 'failed' && input.retryable === true;
      tx.update(
        ref,
        encodeRecord({
          status: input.status,
          retryable,
          availableAt: input.retryAt ?? input.now,
          leaseToken: null,
          leaseUntil: null,
          providerMessageId: input.providerMessageId ?? null,
          result: input.result ?? null,
          finishedAt: retryable ? null : input.now,
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async pending(agentId: string, limit = 100, now = this.store.now()) {
    if (agentId !== this.agentId) throw new Error('Notification outbox is outside the owner');
    const bounded = Math.max(1, Math.min(500, limit));
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx, agentId);
      const collection = this.store.collection('notificationOutbox');
      const snapshots = await Promise.all([
        tx.get(
          collection
            .where('agentId', '==', agentId)
            .where('status', '==', 'pending')
            .where('availableAt', '<=', now)
            .orderBy('availableAt', 'asc')
            .limit(bounded),
        ),
        tx.get(
          collection
            .where('agentId', '==', agentId)
            .where('status', '==', 'failed')
            .where('retryable', '==', true)
            .where('availableAt', '<=', now)
            .orderBy('availableAt', 'asc')
            .limit(bounded),
        ),
      ]);
      return snapshots
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => decodeRecord<NotificationOutboxLeg>(doc.data()))
        .filter((row) => row.agentId === agentId)
        .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())
        .slice(0, bounded);
    });
  }

  async recoverExpired(agentId: string, now: Date) {
    if (agentId !== this.agentId) throw new Error('Notification outbox is outside the owner');
    const expired = await this.store
      .collection('notificationOutbox')
      .where('agentId', '==', agentId)
      .where('status', '==', 'sending')
      .where('leaseUntil', '<=', now)
      .orderBy('leaseUntil', 'asc')
      .limit(400)
      .get();
    let count = 0;
    for (const snapshot of expired.docs) {
      const changed = await this.store.db.runTransaction(async (tx) => {
        await this.owner(tx, agentId);
        const current = await tx.get(snapshot.ref);
        if (!current.exists) return false;
        const row = decodeRecord<NotificationOutboxLeg>(current.data());
        if (
          row.agentId !== agentId ||
          row.status !== 'sending' ||
          !row.leaseUntil ||
          row.leaseUntil.getTime() > now.getTime()
        )
          return false;
        tx.update(
          snapshot.ref,
          encodeRecord({
            status: row.adapter === 'dashboard' ? 'pending' : 'unknown',
            retryable: false,
            result:
              row.adapter === 'dashboard'
                ? {
                    reason:
                      'dashboard append lease expired; deterministic message identity allows safe replay',
                  }
                : { reason: 'send lease expired; provider acceptance is unknown' },
            leaseToken: null,
            leaseUntil: null,
            finishedAt: row.adapter === 'dashboard' ? null : now,
            updatedAt: now,
          }),
        );
        return true;
      });
      if (changed) count += 1;
    }
    return count;
  }
}
