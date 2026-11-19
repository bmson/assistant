import type { OccasionToolRow } from './builtin-tools.js';
import type { Records } from './records.js';

export type BriefingBookingOccurrence = Pick<
  Records['emailBookingOccurrences'],
  | 'bookingKey'
  | 'lifecycle'
  | 'dates'
  | 'sourceChannelMessageId'
  | 'sourceReceivedAt'
  | 'sourceAuthenticated'
  | 'version'
>;

/** Mail the briefing reads from the email-ingest pass. */
export interface BriefingMail {
  fromEmail: string;
  fromName: string | null;
  subject: string;
  category: string;
  importance: number;
  dates: unknown;
  channelMessageId: string;
  authenticated: boolean;
}

export interface BriefingInputs {
  /** Stored personal dates, including their trust and recurrence metadata. */
  occasions?: OccasionToolRow[];
  /** Source-eligible unresolved obligations, including those with no deadline. */
  commitments?: Records['commitments'][];
  /** Mail ingested inside the window, most important first. */
  mail: BriefingMail[];
  /** Latest authenticated, explicitly identified booking lifecycles. */
  bookings: BriefingBookingOccurrence[];
  /** Unarchived work that stopped for the owner inside the window, newest first. */
  attention: Array<{ title: string | null; progress: string }>;
  /** Unexpired approvals on unarchived work. */
  pending: Array<{ shortCode: string; summary: string }>;
  /** Goals changed inside the window, newest first. */
  goalDeltas: Array<{ title: string; status: string; nextAction: string; updatedAt: Date }>;
  /** Watch fires inside the window, newest first. */
  watchHits: Array<{ name: string; summary: string }>;
}

/** The `briefing.compose` job's reads. Composing and posting stay in core. */
export interface BriefingRepository {
  readonly kind: 'briefing-repository';
  inputs(
    agentId: string,
    window: {
      since: Date;
      now: Date;
      attentionLimit: number;
      pendingLimit: number;
      goalLimit: number;
      watchLimit: number;
    },
  ): Promise<BriefingInputs>;
}

export type BriefingRunOutcome =
  | { kind: 'delivered'; messageId: string }
  | { kind: 'quiet' }
  | {
      kind: 'unavailable';
      reason: 'calendar_unavailable' | 'publication_unverified' | 'job_unavailable';
    }
  | { kind: 'aborted' };

export const DAILY_BRIEFING = 'daily-briefing';
export const BRIEFING_DEADLINE_MS = 26 * 60 * 60_000;

type ScheduledBriefingTask = Pick<Records['tasks'], 'id' | 'agentId' | 'trigger' | 'createdAt'>;

export function scheduledBriefingIdentity(task: ScheduledBriefingTask) {
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { job?: unknown; schedule?: unknown; scheduleId?: unknown };
  } | null;
  const payload = trigger?.payload;
  if (
    trigger?.source !== 'schedule' ||
    payload?.job !== 'briefing.compose' ||
    payload?.schedule !== DAILY_BRIEFING ||
    typeof payload.scheduleId !== 'string' ||
    !payload.scheduleId ||
    payload.scheduleId.length > 200
  )
    return null;
  return { scheduleId: payload.scheduleId, agentId: task.agentId, taskId: task.id };
}

export function briefingCursorName(agentId: string, scheduleId: string) {
  return `briefing-watchdog-v1:${agentId}:${scheduleId}`;
}

export function briefingMessageKey(taskId: string) {
  return `briefing:${taskId}`;
}

export function savedBriefingMatches(message: unknown, taskId: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const { role, origin, parts, taskId: linkedTask } = message as Partial<Records['messages']>;
  return (
    role === 'assistant' &&
    origin === 'assistant' &&
    linkedTask === taskId &&
    Array.isArray(parts) &&
    parts.some((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const record = part as { type?: unknown; data?: { kind?: unknown; id?: unknown } };
      return (
        record.type === 'data-card' &&
        record.data?.kind === 'briefing' &&
        record.data.id === `briefing-${taskId}`
      );
    })
  );
}

export interface BriefingWatchdogRecord {
  version: 1;
  scope: string;
  agentId: string;
  scheduleId: string;
  taskId: string;
  taskCreatedAtMs: number;
  recordedAtMs: number;
  outcome: BriefingRunOutcome;
}

export function createBriefingWatchdogRecord(
  scope: string,
  task: ScheduledBriefingTask,
  outcome: BriefingRunOutcome,
  now: Date,
): BriefingWatchdogRecord | null {
  const identity = scheduledBriefingIdentity(task);
  if (!identity) return null;
  return {
    version: 1,
    scope,
    ...identity,
    taskCreatedAtMs: task.createdAt.getTime(),
    recordedAtMs: now.getTime(),
    outcome,
  };
}

export function readBriefingWatchdogRecord(value: unknown): BriefingWatchdogRecord | null {
  if (typeof value !== 'string' || value.length > 5000) return null;
  try {
    const row = JSON.parse(value) as Partial<BriefingWatchdogRecord> | null;
    if (
      !row ||
      row.version !== 1 ||
      typeof row.scope !== 'string' ||
      typeof row.taskId !== 'string' ||
      typeof row.agentId !== 'string' ||
      typeof row.scheduleId !== 'string' ||
      typeof row.taskCreatedAtMs !== 'number' ||
      !Number.isSafeInteger(row.taskCreatedAtMs) ||
      typeof row.recordedAtMs !== 'number' ||
      !Number.isSafeInteger(row.recordedAtMs) ||
      row.taskCreatedAtMs > row.recordedAtMs
    )
      return null;
    const outcome = row.outcome;
    if (!outcome) return null;
    if (
      outcome.kind === 'delivered' &&
      (typeof outcome.messageId !== 'string' ||
        !outcome.messageId ||
        outcome.messageId.length > 200)
    )
      return null;
    if (
      outcome.kind === 'unavailable' &&
      !['calendar_unavailable', 'publication_unverified', 'job_unavailable'].includes(
        outcome.reason,
      )
    )
      return null;
    if (!['delivered', 'quiet', 'unavailable', 'aborted'].includes(outcome.kind)) return null;
    return row as BriefingWatchdogRecord;
  } catch {
    return null;
  }
}

export function shouldReplaceBriefingWatchdog(
  current: BriefingWatchdogRecord | null,
  next: BriefingWatchdogRecord,
): boolean {
  if (!current || current.scope !== next.scope) return true;
  if (current.taskCreatedAtMs !== next.taskCreatedAtMs)
    return current.taskCreatedAtMs < next.taskCreatedAtMs;
  if (current.taskId === next.taskId && current.outcome.kind === 'delivered') return false;
  return current.recordedAtMs <= next.recordedAtMs;
}

export function briefingActivationDate(
  schedule: Pick<Records['schedules'], 'createdAt' | 'taskTemplate'>,
): Date {
  const template = schedule.taskTemplate as { briefingWatchdogActivatedAt?: unknown } | null;
  const timestamp = template?.briefingWatchdogActivatedAt;
  if (typeof timestamp !== 'string') return schedule.createdAt;
  const activated = new Date(timestamp);
  return Number.isFinite(activated.getTime()) && activated >= schedule.createdAt
    ? activated
    : schedule.createdAt;
}

export function reactivatedBriefingTemplate(
  schedule: Pick<Records['schedules'], 'name' | 'enabled' | 'taskTemplate'>,
  enabled: boolean,
  now: Date,
) {
  const template = schedule.taskTemplate as Record<string, unknown> | null;
  return enabled &&
    !schedule.enabled &&
    schedule.name === DAILY_BRIEFING &&
    template?.job === 'briefing.compose'
    ? { ...template, briefingWatchdogActivatedAt: now.toISOString() }
    : undefined;
}
