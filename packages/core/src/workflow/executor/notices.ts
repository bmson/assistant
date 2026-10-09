import {
  createPostgresGoalRuntimeRepository,
  createPostgresNotificationsConversationRepository,
  type Db,
  type TaskRow,
} from '@assistant/db';
import {
  hasEffectiveNotificationDelivery,
  type MessageRepository,
  type NotificationDeliveryResult,
  notificationDeliveryKey,
  notificationLeg,
  notificationLegEntry,
} from '@assistant/persistence';
import { persistMessage } from '../../chat.js';
import { compactChatMessageParts } from '../../chat-card.js';
import { markAttentionNotified } from '../machine.js';
import { GOAL_BLOCKED_PREFIX } from '../schedules.js';
import type { ExecutorDeps } from './types.js';

/**
 * Tell the owner their answer has landed, on the one turn nothing else does.
 *
 * Every other owner-facing task type is delivered by a channel: an SMS turn
 * answers by SMS, an email turn by email. A dashboard chat turn has no
 * channel — the answer is written into the thread and the client is expected
 * to come and find it. That works while someone is looking at the thread, and
 * not at all otherwise: on a locked phone the app's own idle poll is not
 * running, and a local notification raised while it IS running is suppressed
 * as a non-attention category anyway. So the reply arrived in silence.
 *
 * Deliberately `ambient`: the work is done and nothing is waiting on a
 * decision, which is what separates this from the needs-attention ping. The
 * app suppresses this category while it is in the foreground, so someone
 * already reading the reply is not told about it twice.
 *
 * Best-effort by contract, like every other notifier leg: the answer is
 * already durably in the thread, and a push outage must never fail a task
 * that succeeded.
 */
export async function notifyOwnerOfDeliveredAnswer(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
): Promise<boolean> {
  if (!deps.notifyOwner) return false;
  const body = text.trim();
  if (!body) return false;
  const result = await deps
    .notifyOwner({
      deliveryKey: notificationDeliveryKey('task-answer', task.id),
      taskId: task.id,
      conversationId: task.conversationId,
      text: body,
      urgency: 'ambient',
    })
    .catch((err) => {
      console.error('answer-ready notification failed', err);
      return undefined;
    });
  return hasEffectiveNotificationDelivery(result);
}

/**
 * Kinds of notice the chat renders as a card rather than as assistant prose.
 * `parked` is "I stopped and will resume on my own"; `needs-attention` is "I
 * stopped and cannot continue without you". Both are things the owner has to
 * read and act on, so neither should look like conversation.
 */
export type NoticeKind = 'parked' | 'needs-attention' | 'provider-failed';

/**
 * Add the structured marker that makes the chat render a notice as a card
 * rather than as assistant prose. Same shape assistantMessageParts already uses
 * for the response-contract notice (packages/core/src/chat.ts); `parts` is
 * jsonb, so this is additive — messages written before the marker existed carry
 * none and keep rendering as prose. The web app matches these kinds in
 * apps/web/lib/chat-notices.ts.
 *
 * A message that already carries something which speaks for itself is left
 * alone: another notice kind the caller chose, or a decision part (an approval,
 * a spending request) whose own card already says what is waiting. Two markers
 * on one message would leave the interface picking which to believe.
 */
const SELF_DESCRIBING = new Set(['notice', 'approval', 'budget-request', 'suggestion']);

/**
 * Decision parts (approval rows, a spending request) render as their own
 * cards, so a text part carrying the same sentences would render the decision
 * twice. New rows leave the prose out of `parts` entirely — it lives on in
 * the message's `text` column, which is what model history, embeddings, and
 * channel bodies read. Rows written before this change keep both; the chat's
 * isDecisionProseNotice filter covers those.
 */
const CARD_ONLY_PARTS = new Set(['approval', 'budget-request']);

function carriesOwnCard(extraParts: unknown[]): boolean {
  return extraParts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return typeof type === 'string' && CARD_ONLY_PARTS.has(type);
  });
}

export function noticeParts(kind: NoticeKind, extraParts: unknown[] = []): unknown[] {
  const speaksForItself = extraParts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return typeof type === 'string' && SELF_DESCRIBING.has(type);
  });
  return speaksForItself ? extraParts : [...extraParts, { type: 'notice', notice: kind }];
}

/**
 * Parked/paused tasks with a conversation must say so in the thread, not go
 * silent. Returns whether a row was actually persisted so callers can tell
 * whether the owner has any chance of seeing this (used by the re-notify sweep).
 */
export async function postConversationNotice(
  db: Db | MessageRepository,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<boolean> {
  if (!task.conversationId) return false;
  try {
    await persistMessage(db, {
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant',
      origin: 'assistant',
      // A decision card speaks for itself: no duplicated prose part. The prose
      // still lands in `text` (model history and channel bodies read that).
      parts: carriesOwnCard(extraParts)
        ? extraParts
        : compactChatMessageParts(text, [{ type: 'text', text }, ...extraParts], task.id),
      text,
    });
    return true;
  } catch (err) {
    console.error('conversation notice failed', err);
    return false;
  }
}

/**
 * Work with no conversation and the assistant's own trust: started by a
 * schedule or a job rather than by anything the owner said.
 */
export function isBackgroundTask(task: Pick<TaskRow, 'conversationId' | 'trust'>): boolean {
  return !task.conversationId && task.trust === 'assistant';
}

/**
 * Log a notice where background work reports — the Notifications conversation —
 * without mirroring it into the owner's chat or pinging their phone.
 */
export async function postBackgroundNotice(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
  kind: NoticeKind = 'needs-attention',
): Promise<boolean> {
  try {
    const conversationId = await (
      deps.persistence?.notifications ?? createPostgresNotificationsConversationRepository(deps.db)
    ).getOrCreate(task.agentId);
    await persistMessage(deps.persistence?.messages ?? deps.db, {
      conversationId,
      taskId: task.id,
      role: 'assistant',
      origin: 'assistant',
      parts: compactChatMessageParts(
        text,
        [{ type: 'text', text }, ...noticeParts(kind, extraParts)],
        task.id,
      ),
      text,
    });
    return true;
  } catch (err) {
    console.error('background notice failed', err);
    return false;
  }
}

/**
 * Post the dashboard notice AND push it to the owner's channel for events that
 * would otherwise only be visible by opening the dashboard (permanent failure,
 * budget stall). Owner ping is best-effort: a delivery failure must never mask
 * the underlying task outcome. Returns which legs succeeded.
 */
export async function notifyOwnerAndConversation(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
  kind: NoticeKind = 'needs-attention',
): Promise<{
  conversationNotified: boolean;
  ownerNotified: boolean;
  legs: NotificationDeliveryResult['legs'];
}> {
  // Work the assistant started on its own — a scheduled brief, a nightly job —
  // has no thread of its own and nobody waiting on it. When it stalls, that is
  // a line in the Notifications log and a row in Activity, not a message in the
  // owner's conversation and not a buzz on their phone. They did not ask for it,
  // so its trouble is not theirs to be interrupted by.
  if (isBackgroundTask(task)) {
    const conversationNotified = await postBackgroundNotice(deps, task, text, extraParts, kind);
    return {
      conversationNotified,
      ownerNotified: false,
      legs: [
        notificationLegEntry(
          'notifications-conversation',
          conversationNotified ? 'delivered' : 'failed',
        ),
      ],
    };
  }
  // Every caller of this is an event the owner has to resolve — a permanent
  // failure, a budget stall, a blocked goal — so the chat gets the marker that
  // renders it as a waiting-on-you card instead of another assistant reply.
  const conversationNotified = await postConversationNotice(
    deps.persistence?.messages ?? deps.db,
    task,
    text,
    noticeParts(kind, extraParts),
  );
  let ownerDelivery: NotificationDeliveryResult = notificationLeg(
    'owner',
    'skipped',
    'no-notifier',
  );
  if (deps.notifyOwner) {
    const result = await deps
      .notifyOwner({
        deliveryKey: notificationDeliveryKey('task-attention', task.id, kind),
        taskId: task.id,
        conversationId: task.conversationId,
        text,
      })
      .catch((err) => {
        console.error('owner notification failed', err);
        return notificationLeg('owner', 'failed', 'notifier-threw');
      });
    ownerDelivery = result ?? notificationLeg('owner', 'skipped', 'legacy-no-result');
  }
  return {
    conversationNotified,
    ownerNotified: hasEffectiveNotificationDelivery(ownerDelivery),
    legs: [
      notificationLegEntry('task-conversation', conversationNotified ? 'delivered' : 'failed'),
      ...ownerDelivery.legs,
    ],
  };
}

/**
 * Notify the owner that a task needs them (needs_attention / waiting_event) and,
 * only if at least one leg actually reached somewhere the owner can see, stamp
 * the task so the re-notify sweep leaves it alone. If every leg fails (e.g. a
 * conversation-less task with owner push unconfigured), the row stays unstamped
 * and the sweep keeps retrying until Phase-2's sink or a working channel lands.
 */
export async function notifyAttention(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
  kind: NoticeKind = 'needs-attention',
): Promise<void> {
  const { conversationNotified, ownerNotified } = await notifyOwnerAndConversation(
    deps,
    task,
    text,
    extraParts,
    kind,
  );
  if (conversationNotified || ownerNotified) {
    await markAttentionNotified(deps.persistence?.tasks ?? deps.db, task.id).catch((err) =>
      console.error('attention stamp failed', err),
    );
  }
}

/** Runtime-owned budget request; the model never chooses or applies the cap. */
export function taskBudgetPermissionRequest(task: TaskRow, reason: string) {
  const currentBudgetUsd = Number(task.budgetUsdLimit);
  const spentUsd = Number(task.spentUsd);
  const estimatedUsd = Number(reason.match(/est \$([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? 0);
  const proposedBudgetUsd =
    Math.ceil(Math.max(currentBudgetUsd * 2, spentUsd + estimatedUsd) * 4) / 4;
  const text = `I need your permission to raise this task's spending limit from $${currentBudgetUsd.toFixed(2)} to $${proposedBudgetUsd.toFixed(2)} so I can finish. I've spent $${spentUsd.toFixed(4)} so far. Approve the increase in chat or Activity, or decline to stop this task. I won't increase the budget without your approval.`;
  return {
    text,
    part: {
      type: 'budget-request',
      taskId: task.id,
      currentBudgetUsd,
      proposedBudgetUsd,
      spentUsd,
      reason,
    },
  } as const;
}

/**
 * Park the goal itself, not just the task. goalInstruction() re-seeds every
 * session from these columns, so an unanswered question has to land here or
 * tomorrow's run starts from the same stale line and asks all over again.
 */
export async function recordGoalBlocked(
  deps: ExecutorDeps,
  task: Pick<TaskRow, 'agentId' | 'goalId'>,
  question: string,
): Promise<void> {
  if (!task.goalId) return;
  await (deps.persistence?.goals ?? createPostgresGoalRuntimeRepository(deps.db)).recordBlocked({
    agentId: task.agentId,
    goalId: task.goalId,
    nextAction: `${GOAL_BLOCKED_PREFIX} ${question}`.slice(0, 500),
  });
}
