import { type Db, type TaskRow, tasks } from '@assistant/db';
import {
  hasEffectiveNotificationDelivery,
  type MaintenanceRepository,
  type NotificationDeliveryResult,
  type TaskRepository,
} from '@assistant/persistence';
import { and, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getOrCreateNotificationsConversation, persistMessage } from '../chat.js';
import { ownerTaskLabel, sentenceCase } from '../owner-text.js';
import { markAttentionNotified } from './machine.js';

/** Best-effort out-of-band push (SMS today; a no-op when unconfigured). */
export type OwnerPush = (input: {
  taskId: string;
  conversationId: string | null;
  text: string;
}) => Promise<NotificationDeliveryResult | void>;

/**
 * The owner-facing line for a task that is waiting on them, built from its own
 * progress. A task's title is often the first words of the instruction it was
 * given, so it is only quoted when it reads like a name.
 */
function attentionText(task: Pick<TaskRow, 'status' | 'title' | 'progress'>): string {
  const label = ownerTaskLabel(task.title);
  // Progress is the task's own last line, often without a full stop; end it
  // like a sentence so the next one does not run on from it.
  const note = task.progress?.trim().replace(/[.!?\s]+$/u, '');
  const detail = note ? ` ${sentenceCase(note)}.` : '';
  if (task.status === 'waiting_event') {
    return `${label ? `${label} is` : 'A mission is'} paused and waiting on you.${detail} You can wake it from Activity when you're ready.`;
  }
  return `${label ? `I got stuck on ${label}` : 'I got stuck on something'} and need you.${detail} Retry it from Activity, or tell me what to do.`;
}

/**
 * Sweep backstop for a crash between a needs_attention/waiting_event transition
 * and its owner notice: the task is parked for the owner but no dashboard row or
 * push ever went out, so it is invisible until they happen to open Activity.
 * Mirrors renotifyStalledApprovals — re-emit the notice for any waiting-on-owner
 * task whose attention_notified_at is still null after a grace window, then stamp
 * it. At-least-once safe: a concurrent stamp/wake just makes the next sweep skip
 * it, and a per-task failure leaves the row unstamped for the next pass.
 */
export async function renotifyStalledAttention(
  store: Db | { maintenance: MaintenanceRepository; tasks: TaskRepository },
  notifyOwner?: OwnerPush,
  opts: { olderThanMinutes?: number; batch?: number } = {},
): Promise<number> {
  const olderThanMinutes = opts.olderThanMinutes ?? 5;
  if ('maintenance' in store) return renotifyPortable(store, notifyOwner, olderThanMinutes, opts);
  const db = store as Db;
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ['needs_attention', 'waiting_event']),
        isNull(tasks.attentionNotifiedAt),
        lte(tasks.updatedAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .limit(opts.batch ?? 50);
  if (rows.length === 0) return 0;

  let renotified = 0;
  for (const task of rows) {
    try {
      const text = attentionText(task);
      let notified = false;
      // Deliver to the task's own thread, or — for a conversation-less assistant
      // task — the Notifications sink, so the owner has an on-dashboard copy even
      // when the out-of-band push is unconfigured.
      const conversationId =
        task.conversationId ??
        (task.trust === 'assistant'
          ? await getOrCreateNotificationsConversation(db, task.agentId)
          : null);
      if (conversationId) {
        await persistMessage(db, {
          conversationId,
          taskId: task.id,
          role: 'assistant',
          origin: 'assistant',
          // The structured marker renders this as a "Needs you" card rather
          // than assistant prose, and keys the runtime-state collapse by part
          // instead of by the text's opening (NEEDS_ATTENTION_PREFIXES stays
          // for rows written before this marker existed).
          parts: [
            { type: 'text', text },
            { type: 'notice', notice: 'needs-attention' },
          ],
          text,
        });
        notified = true;
      }
      // Background work reports to the log, not to the owner's chat or phone.
      if (notifyOwner && !(task.trust === 'assistant' && !task.conversationId)) {
        const result = await notifyOwner({
          taskId: task.id,
          conversationId: task.conversationId,
          text,
        }).catch((err) => {
          console.error('attention owner push failed', { taskId: task.id }, err);
          return undefined;
        });
        notified = hasEffectiveNotificationDelivery(result) || notified;
      }
      // Only stamp if the notice actually reached somewhere the owner sees. A
      // conversation-less task with no working push stays unstamped so a later
      // sweep (or Phase-2's Notifications sink) can still deliver it.
      if (notified && (await markAttentionNotified(db, task.id))) renotified += 1;
    } catch (err) {
      // Leave the row unstamped — the next sweep retries this task.
      console.error('attention re-notification failed', { taskId: task.id }, err);
    }
  }
  return renotified;
}

async function renotifyPortable(
  store: { maintenance: MaintenanceRepository; tasks: TaskRepository },
  notifyOwner: OwnerPush | undefined,
  olderThanMinutes: number,
  opts: { batch?: number },
): Promise<number> {
  const rows = await store.maintenance.listStalledAttention({
    olderThanMinutes,
    batch: opts.batch ?? 50,
  });
  let renotified = 0;
  for (const task of rows) {
    try {
      const text = attentionText(task);
      // The same destinations as the PostgreSQL pass: the task's own thread,
      // or the Notifications sink for a conversation-less assistant task.
      let notified = await store.maintenance.postAttentionNotice({
        taskId: task.id,
        text,
        parts: [
          { type: 'text', text },
          { type: 'notice', notice: 'needs-attention' },
        ],
      });
      // Background work reports to the log, not to the owner's chat or phone.
      if (notifyOwner && !(task.trust === 'assistant' && !task.conversationId)) {
        const result = await notifyOwner({
          taskId: task.id,
          conversationId: task.conversationId,
          text,
        }).catch((err) => {
          console.error('attention owner push failed', { taskId: task.id }, err);
          return undefined;
        });
        notified = hasEffectiveNotificationDelivery(result) || notified;
      }
      if (notified && (await markAttentionNotified(store.tasks, task.id))) renotified += 1;
    } catch (err) {
      console.error('attention re-notification failed', { taskId: task.id }, err);
    }
  }
  return renotified;
}
