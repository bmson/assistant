import type { PhoneCalendarSharingState } from './phone-calendar-sharing.js';
import type { PhoneCalendarSnapshot } from './phone-calendars.js';

/** Read-only rollback bridge. It cannot grant consent or publish snapshots. */
export interface PhoneCalendarCompatibilityRepository {
  read(ownerId: string): Promise<{
    schema: 'legacy' | 'sharing';
    state: PhoneCalendarSharingState | null;
  }>;
}

/** Export consent metadata, never publisher/mutation tokens or cached events. */
export function phoneCalendarSharingExport(state: PhoneCalendarSharingState | null) {
  return {
    scope: 'consent-metadata-only' as const,
    eventCachePolicy: 'transient-event-cache-excluded' as const,
    state: state
      ? {
          enabled: state.enabled,
          generation: state.generation,
          consentVersion: state.consentVersion,
          calendars: state.calendars,
          updatedAt: state.updatedAt,
          capturedAt: state.capturedAt,
          receivedAt: state.receivedAt,
          timeMin: state.timeMin,
          timeMax: state.timeMax,
          complete: state.complete,
          truncated: state.truncated,
        }
      : null,
  };
}

/** Known selections stay visible during rollback; this binary cannot assert B coverage. */
export function unavailableSharedPhoneCalendars(
  state: PhoneCalendarSharingState | null,
): PhoneCalendarSnapshot | null {
  if (!state?.enabled || state.calendars.length === 0) return null;
  return {
    calendars: state.calendars,
    events: [],
    timeMin: state.timeMin ?? '1970-01-01T00:00:00.000Z',
    timeMax: state.timeMax ?? '1970-01-01T00:00:01.000Z',
    timeZone: 'UTC',
    capturedAt: state.capturedAt,
    syncedAt: state.receivedAt ?? '1970-01-01T00:00:00.000Z',
    selectionRevision: state.generation,
    complete: false,
    truncated: false,
    sourceAvailability: state.calendars.map((calendar) => ({
      calendarId: calendar.id,
      status: 'missing',
      complete: false,
      reason:
        'This server version cannot verify shared iPhone calendar coverage. Restore the calendar-sharing server version before refreshing.',
    })),
  };
}
