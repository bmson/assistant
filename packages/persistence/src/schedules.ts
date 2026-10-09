import type { GoalSessionState } from './goals.js';
import type { Records } from './records.js';
import { reminderScheduleTemplate } from './reminders.js';
import type { TaskCreateInput, TaskCreateResult } from './task-creation.js';

export type ScheduleRecord = Records['schedules'];
export interface ScheduleCreateInput {
  agentId: string;
  name: string;
  cron: string;
  taskTemplate: unknown;
  enabled?: boolean;
  nextRunAt: Date | null;
}
export interface GoalOccurrenceGuard {
  goal: NonNullable<GoalSessionState['goal']>;
  openTasks: GoalSessionState['openTasks'];
  supersedeTaskIds: string[];
}
export interface ScheduleOccurrence {
  expected: ScheduleRecord;
  /** Read-only preparation; supersession is committed with this occurrence. */
  goalGuard?: GoalOccurrenceGuard;
  now: Date;
  /** Early wake briefs must supply an unchanged snapshot just like ordinary firings. */
  mode: 'due' | 'early';
  nextRunAt: Date | null;
  enabled: boolean;
  /** Null advances a skipped/disabled job without creating work. */
  task: TaskCreateInput | null;
}
export interface ScheduleCommitResult {
  schedule: ScheduleRecord;
  task: TaskCreateResult | null;
}
export interface ScheduleRepository {
  readonly kind: 'schedule-repository';
  /** Owner-scoped ID keyset page. Cursor is the last scanned ID; null means exhausted. */
  listPage(
    agentId: string,
    options?: { afterId?: string; limit?: number },
  ): Promise<{ items: ScheduleRecord[]; nextCursor: string | null }>;
  /** Create once per agent/name; an existing schedule is returned unchanged. */
  ensure(input: ScheduleCreateInput): Promise<ScheduleRecord>;
  getByName(agentId: string, name: string): Promise<ScheduleRecord | null>;
  /** Owner settings mutation. Reminder schedules are excluded by every adapter. */
  setOwnerEnabled(agentId: string, scheduleId: string, enabled: boolean): Promise<boolean>;
  listUninitialized(limit?: number): Promise<ScheduleRecord[]>;
  listDue(now: Date, limit?: number): Promise<ScheduleRecord[]>;
  initialize(expected: ScheduleRecord, nextRunAt: Date, now: Date): Promise<boolean>;
  /** Rechecks the entire snapshot, cancellation and due time under the adapter's lock.
   * Task creation and schedule advancement commit together. Firestore includes the
   * first outbox intent in that same transaction. No external side effects here. */
  commitOccurrence(input: ScheduleOccurrence): Promise<ScheduleCommitResult | null>;
}

export function scheduleBatch(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Invalid schedule batch');
  return limit;
}
export function scheduleTime(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid schedule time');
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, field) =>
    field && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)))
      : field,
  );
}
/** Compare decoded rows while locked, avoiding PostgreSQL sub-millisecond SQL timestamp equality. */
export function scheduleMatches(current: ScheduleRecord, expected: ScheduleRecord): boolean {
  return canonical(current) === canonical(expected);
}
export function scheduleCanRun(row: ScheduleRecord): boolean {
  const template = reminderScheduleTemplate(row.taskTemplate);
  return row.enabled && !template.reminderCancelledAt && !template.reminderDeliveredAt;
}
export function validateScheduleCreate(input: ScheduleCreateInput): void {
  if (!input.agentId || !input.name || !input.cron) throw new Error('Invalid schedule creation');
  if (input.nextRunAt !== null) scheduleTime(input.nextRunAt);
}
export function occurrenceIsCurrent(current: ScheduleRecord, input: ScheduleOccurrence): boolean {
  scheduleTime(input.now);
  if (input.nextRunAt !== null) scheduleTime(input.nextRunAt);
  if (input.enabled && (!input.nextRunAt || input.nextRunAt <= input.now))
    throw new Error('Schedule must advance past this firing');
  if (!input.enabled && input.nextRunAt !== null)
    throw new Error('Disabled schedule cannot have a next firing');
  if (!['due', 'early'].includes(input.mode)) throw new Error('Invalid schedule firing mode');
  if (!scheduleMatches(current, input.expected) || !scheduleCanRun(current)) return false;
  if (input.mode === 'due' && (!current.nextRunAt || current.nextRunAt > input.now)) return false;
  if (input.task) {
    const trigger = input.task.trigger as {
      source?: string;
      payload?: { scheduleId?: string; occurrenceId?: string };
    } | null;
    const eventId = input.task.externalEventId;
    const expectedEventId = current.nextRunAt
      ? `schedule:${current.id}:${current.nextRunAt.toISOString()}`
      : null;
    const validEvent =
      input.mode === 'due'
        ? eventId === expectedEventId
        : typeof eventId === 'string' &&
          eventId.startsWith(`schedule:${current.id}:wake:`) &&
          /^\d{4}-\d{2}-\d{2}$/.test(eventId.slice(`schedule:${current.id}:wake:`.length));
    if (
      input.task.agentId !== current.agentId ||
      input.task.trust !== 'assistant' ||
      input.task.parentTaskId ||
      trigger?.source !== 'schedule' ||
      trigger.payload?.scheduleId !== current.id ||
      !validEvent ||
      trigger.payload?.occurrenceId !== eventId
    )
      throw new Error('Task does not belong to this schedule occurrence');
  }
  return true;
}

export const GOAL_TASK_TERMINAL = ['done', 'failed', 'cancelled'];
export const GOAL_SUPERSEDED_PROGRESS = 'superseded by the next automatic session';
/** Compare the complete goal and the exact open task versions while locked. */
export function goalOccurrenceIsCurrent(
  input: ScheduleOccurrence,
  goal: Records['goals'] | null,
  openTasks: GoalSessionState['openTasks'],
): boolean {
  const guard = input.goalGuard;
  if (!guard) {
    if (input.task?.goalId) throw new Error('Goal occurrence requires its preparation guard');
    return true;
  }
  if (
    !input.task ||
    input.task.goalId !== guard.goal.id ||
    input.task.agentId !== guard.goal.agentId
  )
    throw new Error('Goal occurrence is outside its preparation guard');
  if (
    !goal ||
    goal.status !== 'active' ||
    goal.archivedAt ||
    canonical(goal) !== canonical(guard.goal)
  )
    return false;
  const ordered = (rows: GoalSessionState['openTasks']) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  if (canonical(ordered(openTasks)) !== canonical(ordered(guard.openTasks))) return false;
  if (
    new Set(guard.supersedeTaskIds).size !== guard.supersedeTaskIds.length ||
    guard.supersedeTaskIds.some(
      (id) => !openTasks.some((task) => task.id === id && task.status === 'needs_attention'),
    )
  )
    throw new Error('Invalid stalled task supersession');
  return true;
}
