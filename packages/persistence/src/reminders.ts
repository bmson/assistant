import type { TaskLease } from './contracts.js';
import type { Records } from './records.js';

export const REMINDER_SCHEDULE_PREFIX = 'reminder:';

/** Provider evidence that names one sports fixture without trusting model fields. */
export interface ReminderEventDependency {
  provider: 'sports';
  eventId: string;
  league: string;
  startsAt: string;
  eventDate: string;
  timezone: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeam: string;
  awayTeam: string;
  verifiedAt: string;
}

export interface ReminderScheduleTemplate {
  reminderText?: string;
  reminderKind?: 'once' | 'recurring' | 'event_completion';
  reminderEventDependency?: ReminderEventDependency;
  reminderCancelledAt?: string;
  reminderDeliveredAt?: string;
  [key: string]: unknown;
}

export function reminderScheduleTemplate(value: unknown): ReminderScheduleTemplate {
  return (value ?? {}) as ReminderScheduleTemplate;
}

export function reminderScheduleIsActive(row: Records['schedules']): boolean {
  const template = reminderScheduleTemplate(row.taskTemplate);
  if (template.reminderCancelledAt || template.reminderDeliveredAt) return false;
  return template.reminderKind === 'once' || row.enabled;
}

export interface ReminderDeliveryInput {
  agentId: string;
  /** The reminder schedule that fired this task. */
  reminderId: string;
  /** The occurrence stamped on the task event when the schedule fired. */
  occurrenceId: string;
  /** The executing lease; delivery commits only while it still owns the task. */
  lease: TaskLease;
  /** The task's own chat, or null to use the owner's Notifications chat. */
  conversationId: string | null;
  text: string;
  parts: unknown[];
}

export type ReminderDeliveryOutcome =
  | { delivered: true; conversationId: string }
  | { delivered: false };

/**
 * Durable reminder delivery for the portable schedule runner. The in-app
 * message, the per-occurrence receipt, and a one-time reminder's delivered
 * stamp commit together. A cancelled, already delivered, or lease-lost
 * occurrence reports `delivered: false` and writes nothing. Out-of-band pings
 * stay outside this call so a transaction retry can never send twice.
 */
export interface ReminderDeliveryRepository {
  readonly kind: 'reminder-delivery-repository';
  deliver(input: ReminderDeliveryInput): Promise<ReminderDeliveryOutcome>;
}
