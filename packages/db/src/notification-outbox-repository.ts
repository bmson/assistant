import { randomUUID } from 'node:crypto';
import type {
  EmailObserverEffectFence,
  NotificationOutboxLeg,
  NotificationOutboxRepository,
} from '@assistant/persistence';
import { matchesPreparedEmailObserverClaim } from '@assistant/persistence';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { postgresApplicationConfirmationNoticeIsCurrent } from './application-confirmation-notice-fence.js';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { emailObserverWork, notificationOutbox } from './schema.js';

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

async function preparedEmailWorkIsCurrent(
  tx: Db,
  input: Parameters<NotificationOutboxRepository['prepare']>[0],
  fence: EmailObserverEffectFence,
  currentTime: () => Date,
): Promise<boolean> {
  if (fence.agentId !== input.agentId) return false;
  const currentGeneration = await postgresPrivacyObservationFence(tx, input.agentId);
  if (currentGeneration !== fence.expectedPrivacyGeneration) return false;
  const [work] = await tx
    .select()
    .from(emailObserverWork)
    .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, input.agentId)))
    .for('update')
    .limit(1);
  // Sample after acquiring the observer row lock, so waiting for a competing
  // claim cannot make a stale caller timestamp authorize an expired effect.
  return matchesPreparedEmailObserverClaim(work ?? null, fence, currentTime());
}

async function persistedEmailWorkIsCurrent(tx: Db, row: NotificationOutboxLeg): Promise<boolean> {
  if (row.producerWorkId && row.producerTaskId) return false;
  if (row.producerTaskId) {
    if (!row.producerApplicationId || !row.producerConfirmationMessageId) return false;
    return postgresApplicationConfirmationNoticeIsCurrent(
      tx,
      {
        agentId: row.agentId,
        taskId: row.producerTaskId,
        taskLeaseToken: '',
        taskQueueGeneration: -1,
        applicationId: row.producerApplicationId,
        confirmationMessageId: row.producerConfirmationMessageId,
        producerPrivacyGeneration: row.producerPrivacyGeneration ?? null,
      },
      false,
    );
  }
  if (!row.producerWorkId) return true;
  const generation = row.producerPrivacyGeneration ?? null;
  if ((await postgresPrivacyObservationFence(tx, row.agentId)) !== generation) return false;
  const [work] = await tx
    .select({
      agentId: emailObserverWork.agentId,
      privacyGeneration: emailObserverWork.privacyGeneration,
      status: emailObserverWork.status,
    })
    .from(emailObserverWork)
    .where(
      and(eq(emailObserverWork.id, row.producerWorkId), eq(emailObserverWork.agentId, row.agentId)),
    )
    .for('share')
    .limit(1);
  return Boolean(
    work &&
      work.agentId === row.agentId &&
      work.privacyGeneration === generation &&
      work.status !== 'skipped_erased',
  );
}

/** PostgreSQL outbox with owner/privacy fencing on every read and transition. */
export function createPostgresNotificationOutboxRepository(
  db: Db,
  currentTime: () => Date = () => new Date(),
): NotificationOutboxRepository {
  return {
    kind: 'notification-outbox-repository',
    async prepare(input) {
      assertPreparation(input);
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, input.agentId);
        const fence = input.emailObserverEffectFence;
        const noticeFence = input.applicationConfirmationNoticeFence;
        if (fence && noticeFence) throw new Error('Notification outbox accepts one producer fence');
        if (
          fence &&
          !(await preparedEmailWorkIsCurrent(tx as unknown as Db, input, fence, currentTime))
        )
          throw new Error('Email observer notification prepare fence is stale');
        if (
          noticeFence &&
          !(await postgresApplicationConfirmationNoticeIsCurrent(
            tx as unknown as Db,
            noticeFence,
            true,
          ))
        )
          throw new Error('Application confirmation notification prepare fence is stale');
        const [inserted] = await tx
          .insert(notificationOutbox)
          .values({
            agentId: input.agentId,
            deliveryKey: input.deliveryKey,
            legKey: input.legKey,
            adapter: input.adapter,
            status: 'pending',
            destination: input.destination,
            payload: input.payload,
            producerWorkId: fence?.id ?? null,
            producerTaskId: noticeFence?.taskId ?? null,
            producerApplicationId: noticeFence?.applicationId ?? null,
            producerConfirmationMessageId: noticeFence?.confirmationMessageId ?? null,
            producerPrivacyGeneration:
              fence?.expectedPrivacyGeneration ?? noticeFence?.producerPrivacyGeneration ?? null,
            availableAt: input.now,
          })
          .onConflictDoNothing({
            target: [
              notificationOutbox.agentId,
              notificationOutbox.deliveryKey,
              notificationOutbox.legKey,
            ],
          })
          .returning();
        const [existing] = inserted
          ? [inserted]
          : await tx
              .select()
              .from(notificationOutbox)
              .where(
                and(
                  eq(notificationOutbox.agentId, input.agentId),
                  eq(notificationOutbox.deliveryKey, input.deliveryKey),
                  eq(notificationOutbox.legKey, input.legKey),
                ),
              )
              .limit(1);
        if (!existing) throw new Error('notification outbox preparation did not persist');
        if (
          existing.adapter !== input.adapter ||
          (existing.producerWorkId ?? null) !== (fence?.id ?? null) ||
          (existing.producerTaskId ?? null) !== (noticeFence?.taskId ?? null) ||
          (existing.producerApplicationId ?? null) !== (noticeFence?.applicationId ?? null) ||
          (existing.producerConfirmationMessageId ?? null) !==
            (noticeFence?.confirmationMessageId ?? null) ||
          (existing.producerPrivacyGeneration ?? null) !==
            (fence?.expectedPrivacyGeneration ?? noticeFence?.producerPrivacyGeneration ?? null) ||
          (existing.destination !== null &&
            canonical(existing.destination) !== canonical(input.destination)) ||
          (existing.payload !== null && canonical(existing.payload) !== canonical(input.payload))
        )
          throw new Error('notification delivery identity reused with a different frozen intent');
        return existing as NotificationOutboxLeg;
      });
    },
    async claim(input) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, input.agentId);
        const [current] = await tx
          .select()
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.agentId, input.agentId),
              eq(notificationOutbox.id, input.legId),
            ),
          )
          .for('update')
          .limit(1);
        if (
          !current ||
          !(current.status === 'pending' || (current.status === 'failed' && current.retryable))
        )
          return null;
        const producerCurrent = await persistedEmailWorkIsCurrent(
          tx as unknown as Db,
          current as NotificationOutboxLeg,
        );
        // Use time sampled after the outbox and producer rows have been read.
        const now = currentTime();
        if (current.availableAt.getTime() > now.getTime()) return null;
        if (!producerCurrent) {
          const [scrubbed] = await tx
            .update(notificationOutbox)
            .set({
              status: 'skipped',
              retryable: false,
              destination: null,
              payload: null,
              leaseToken: null,
              leaseUntil: null,
              result: { reason: 'email-observer-fence-invalid' },
              finishedAt: now,
              updatedAt: now,
            })
            .where(eq(notificationOutbox.id, input.legId))
            .returning();
          return scrubbed as NotificationOutboxLeg | null;
        }
        const leaseToken = randomUUID();
        const [row] = await tx
          .update(notificationOutbox)
          .set({
            status: 'sending',
            attempts: sql`${notificationOutbox.attempts} + 1`,
            retryable: false,
            leaseToken,
            leaseUntil: new Date(now.getTime() + Math.max(1000, input.leaseMs)),
            updatedAt: now,
          })
          .where(eq(notificationOutbox.id, input.legId))
          .returning();
        return (row as NotificationOutboxLeg | undefined) ?? null;
      });
    },
    async complete(input) {
      const retryable = input.status === 'failed' && input.retryable === true;
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, input.agentId);
        const [row] = await tx
          .update(notificationOutbox)
          .set({
            status: input.status,
            retryable,
            availableAt: input.retryAt ?? input.now,
            leaseToken: null,
            leaseUntil: null,
            providerMessageId: input.providerMessageId ?? null,
            result: input.result ?? null,
            finishedAt: retryable ? null : input.now,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(notificationOutbox.agentId, input.agentId),
              eq(notificationOutbox.id, input.legId),
              eq(notificationOutbox.status, 'sending'),
              eq(notificationOutbox.leaseToken, input.leaseToken),
            ),
          )
          .returning({ id: notificationOutbox.id });
        return Boolean(row);
      });
    },
    async pending(agentId, limit = 100, now = new Date()) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, agentId);
        return (await tx
          .select()
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.agentId, agentId),
              inArray(notificationOutbox.status, ['pending', 'failed']),
              lte(notificationOutbox.availableAt, now),
              or(eq(notificationOutbox.status, 'pending'), eq(notificationOutbox.retryable, true)),
            ),
          )
          .orderBy(asc(notificationOutbox.availableAt), asc(notificationOutbox.createdAt))
          .limit(Math.max(1, Math.min(500, limit)))) as NotificationOutboxLeg[];
      });
    },
    async recoverExpired(agentId, now) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, agentId);
        const rows = await tx
          .update(notificationOutbox)
          .set({
            status: sql`case when ${notificationOutbox.adapter} = 'dashboard' then 'pending' else 'unknown' end`,
            retryable: false,
            result: sql`case when ${notificationOutbox.adapter} = 'dashboard' then '{"reason":"dashboard append lease expired; deterministic message identity allows safe replay"}'::jsonb else '{"reason":"send lease expired; provider acceptance is unknown"}'::jsonb end`,
            leaseToken: null,
            leaseUntil: null,
            finishedAt: sql`case when ${notificationOutbox.adapter} = 'dashboard' then null else ${now.toISOString()}::timestamptz end`,
            updatedAt: now,
          })
          .where(
            and(
              eq(notificationOutbox.agentId, agentId),
              eq(notificationOutbox.status, 'sending'),
              lte(notificationOutbox.leaseUntil, now),
            ),
          )
          .returning({ id: notificationOutbox.id });
        return rows.length;
      });
    },
  };
}
