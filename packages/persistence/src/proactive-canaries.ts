import type { GoogleCalendarConnectionRepository } from './google-calendar-connection.js';
import type { OwnerContextRepository } from './owner-context.js';
import type { PhoneCalendarSharingRepository } from './phone-calendar-sharing.js';
import type { Records } from './records.js';

export const PULSE_SCHEDULE = 'pulse';
export const PULSE_INTERVAL_MS = 60 * 60_000;

export const PROACTIVE_CANARY_ALERT_KINDS = [
  'mail_processing_stalled',
  'proactive_canary_briefing',
  'proactive_canary_budget',
  'proactive_canary_pulse',
  'proactive_canary_googleCalendar',
  'proactive_canary_phoneCalendar',
  'proactive_canary_weather',
  'proactive_canary_urgentSms',
] as const;

export interface ProactiveCanaryRepository {
  pulse(ownerId: string): Promise<{
    schedule: Records['schedules'] | null;
    completedAt: Date | null;
  }>;
  google: Pick<GoogleCalendarConnectionRepository, 'get'>;
  phone: Pick<PhoneCalendarSharingRepository, 'readSnapshot'>;
  context: OwnerContextRepository;
  briefing(ownerId: string, now: Date): Promise<{ state: string }>;
  hasOpenAlert(ownerId: string, since: Date): Promise<boolean>;
  sms(ownerId: string): Promise<{ cursor: string | null; timeZone: string }>;
}

export function pulseCompletionName(agentId: string, scheduleId: string) {
  return `pulse-completion-v1:${agentId}:${scheduleId}`;
}

export function pulseCompletionFor(
  task: Pick<Records['tasks'], 'agentId' | 'trigger'>,
  scope: string,
  now: Date,
) {
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { job?: unknown; schedule?: unknown; scheduleId?: unknown };
  } | null;
  const payload = trigger?.payload;
  if (
    trigger?.source !== 'schedule' ||
    payload?.job !== 'pulse.check' ||
    payload.schedule !== PULSE_SCHEDULE ||
    typeof payload.scheduleId !== 'string' ||
    !payload.scheduleId ||
    payload.scheduleId.length > 200
  )
    return null;
  return {
    name: pulseCompletionName(task.agentId, payload.scheduleId),
    cursor: scope,
    updatedAt: now,
  };
}
