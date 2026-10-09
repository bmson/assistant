import { createHash, randomUUID } from 'node:crypto';
import {
  type AppendMessageInput,
  REMINDER_SCHEDULE_PREFIX,
  type Records,
  type ReminderDeliveryInput,
  type ReminderDeliveryOutcome,
  type ReminderDeliveryRepository,
  type ReminderRepository,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
  type TaskLease,
} from '@assistant/persistence';
import { messageRecord } from './messages.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

/** Cancellation and durable delivery serialize on the same schedule document. */
export class FirestoreReminderRepository implements ReminderRepository {
  readonly kind = 'reminder-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async cancel(agentId: string, reminderId: string, suppliedNow?: Date) {
    const ref = this.store.doc('schedules', reminderId);
    return this.store.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { cancelled: false };
      const row = decodeRecord<Records['schedules']>(snap.data());
      if (
        row.agentId !== agentId ||
        !row.name.startsWith(REMINDER_SCHEDULE_PREFIX) ||
        !reminderScheduleIsActive(row)
      )
        return { cancelled: false };
      const now = suppliedNow ?? this.store.now();
      const template = reminderScheduleTemplate(row.taskTemplate);
      // Bounded cleanup; the authoritative cancellation fence also covers tasks outside
      // this page and running workers. Every delivery must call deliver(), below.
      const queued = await tx.get(
        this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('trigger.payload.scheduleId', '==', reminderId)
          .where('status', 'in', [
            'pending',
            'sleeping',
            'waiting_budget',
            'waiting_approval',
            'waiting_event',
            'needs_attention',
          ])
          .limit(200),
      );
      tx.update(ref, {
        enabled: false,
        nextRunAt: null,
        taskTemplate: { ...template, reminderCancelledAt: now.toISOString() },
        updatedAt: now,
      });
      for (const task of queued.docs)
        tx.update(task.ref, {
          status: 'cancelled',
          progress: 'cancelled because its reminder was removed',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          updatedAt: now,
        });
      return {
        cancelled: true,
        text: template.reminderText ?? '',
        queuedTasksCancelled: queued.size,
      };
    });
  }

  /**
   * Commit a reminder's in-app notification while its task still owns the lease.
   * This deliberately accepts data, not a callback. External delivery needs a separately
   * fenced outbox consumer; transaction retries must never send mail or push themselves.
   */
  async deliver(input: {
    agentId: string;
    reminderId: string;
    occurrenceId: string;
    lease: TaskLease;
    message: AppendMessageInput;
  }): Promise<boolean> {
    if (
      input.message.taskId !== input.lease.id ||
      input.message.role !== 'assistant' ||
      input.message.origin !== 'assistant' ||
      !input.occurrenceId
    )
      throw new Error('Invalid reminder delivery');
    const key = createHash('sha256')
      .update(JSON.stringify([input.reminderId, input.occurrenceId]))
      .digest('hex');
    const messageId = randomUUID();
    const scheduleRef = this.store.doc('schedules', input.reminderId);
    return this.store.db.runTransaction(async (tx) => {
      const [schedule, task, receipt, conversation] = await tx.getAll(
        scheduleRef,
        this.store.doc('tasks', input.lease.id),
        this.store.doc('reminderDeliveries', key),
        this.store.doc('conversations', input.message.conversationId),
      );
      if (!schedule?.exists || !task?.exists || !conversation?.exists) return false;
      // Owner content must not reappear while an erasure is deleting it; the
      // task retries after the erasure completes.
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const row = decodeRecord<Records['schedules']>(schedule.data());
      const lease = decodeRecord<TaskLease>(task.data());
      const now = this.store.now();
      const trigger = lease.trigger as {
        payload?: { scheduleId?: string; occurrenceId?: string };
      } | null;
      if (
        row.agentId !== input.agentId ||
        conversation.data()?.agentId !== input.agentId ||
        lease.agentId !== input.agentId ||
        trigger?.payload?.scheduleId !== row.id ||
        lease.externalEventId !== input.occurrenceId ||
        trigger?.payload?.occurrenceId !== input.occurrenceId ||
        !row.name.startsWith(REMINDER_SCHEDULE_PREFIX)
      )
        return false;
      if (receipt?.exists) return false;
      if (
        !reminderScheduleIsActive(row) ||
        lease.status !== 'running' ||
        !input.lease.leaseToken ||
        lease.leaseToken !== input.lease.leaseToken ||
        lease.lockedUntil <= now
      )
        return false;
      const message = messageRecord(input.message, messageId, now);
      tx.create(this.store.doc('messages', messageId), encodeRecord(message));
      tx.create(this.store.doc('reminderDeliveries', key), {
        scheduleId: row.id,
        taskId: lease.id,
        occurrenceId: input.occurrenceId,
        messageId,
        createdAt: now,
      });
      const template = reminderScheduleTemplate(row.taskTemplate);
      tx.update(scheduleRef, {
        updatedAt: now,
        ...(template.reminderKind === 'once' || template.reminderKind === 'event_completion'
          ? {
              enabled: false,
              nextRunAt: null,
              taskTemplate: { ...template, reminderDeliveredAt: now.toISOString() },
            }
          : {}),
      });
      tx.update(conversation.ref, { updatedAt: now });
      return true;
    });
  }
}

/** Executor-facing reminder delivery for one configured owner. */
export class FirestoreReminderDeliveryRepository implements ReminderDeliveryRepository {
  readonly kind = 'reminder-delivery-repository' as const;
  private readonly reminders: FirestoreReminderRepository;
  private readonly notices: FirestoreOwnerNoticeRepository;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {
    this.reminders = new FirestoreReminderRepository(store);
    this.notices = new FirestoreOwnerNoticeRepository(store, agentId);
  }

  async deliver(input: ReminderDeliveryInput): Promise<ReminderDeliveryOutcome> {
    if (!this.agentId || input.agentId !== this.agentId || input.lease.agentId !== this.agentId)
      throw new Error('Reminder delivery is outside the configured Firestore agent');
    const conversationId =
      input.conversationId ?? (await this.notices.notificationsConversationId());
    const delivered = await this.reminders.deliver({
      agentId: input.agentId,
      reminderId: input.reminderId,
      occurrenceId: input.occurrenceId,
      lease: input.lease,
      message: {
        conversationId,
        taskId: input.lease.id,
        role: 'assistant',
        origin: 'assistant',
        parts: input.parts,
        text: input.text,
      },
    });
    return delivered ? { delivered: true, conversationId } : { delivered: false };
  }
}
