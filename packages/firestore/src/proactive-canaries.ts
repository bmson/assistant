import {
  PROACTIVE_CANARY_ALERT_KINDS,
  type ProactiveCanaryRepository,
  PULSE_SCHEDULE,
  proactiveSmsQuotaName,
  pulseCompletionName,
} from '@assistant/persistence';
import { readFirestoreBriefingHealth } from './briefing-watchdog.js';
import { createFirestoreGoogleCalendarConnectionRepository } from './google-calendar-connections.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import { createFirestorePhoneCalendarSharingRepository } from './phone-calendar-sharing.js';
import { FirestoreScheduleRepository } from './schedules.js';
import type { InstallationStore } from './store.js';

export function createFirestoreProactiveCanaryRepository(
  store: InstallationStore,
): ProactiveCanaryRepository {
  return {
    async pulse(ownerId) {
      const schedule = await new FirestoreScheduleRepository(store).getByName(
        ownerId,
        PULSE_SCHEDULE,
      );
      const row = schedule?.enabled
        ? await store.doc('maintenanceCursors', pulseCompletionName(ownerId, schedule.id)).get()
        : undefined;
      return {
        schedule,
        completedAt:
          row?.get('cursor') === `firestore:${store.installationId}`
            ? (row.get('updatedAt')?.toDate() ?? null)
            : null,
      };
    },
    google: createFirestoreGoogleCalendarConnectionRepository(store),
    phone: createFirestorePhoneCalendarSharingRepository(store),
    context: new FirestoreOwnerContextRepository(store),
    briefing: (ownerId, now) => readFirestoreBriefingHealth(store, ownerId, now),
    async hasOpenAlert(ownerId, since) {
      const rows = await store
        .collection('assistantHealthAlerts')
        .where('agentId', '==', ownerId)
        .limit(200)
        .get();
      const kinds = new Set<string>(PROACTIVE_CANARY_ALERT_KINDS);
      return rows.docs.some(
        (row) =>
          row.get('status') === 'open' &&
          kinds.has(row.get('kind')) &&
          (row.get('lastSeenAt')?.toMillis?.() ?? -1) >= since.getTime(),
      );
    },
    async sms(ownerId) {
      const [owner, row] = await store.db.getAll(
        store.doc('agents', ownerId),
        store.doc('maintenanceCursors', proactiveSmsQuotaName(ownerId)),
      );
      const timeZone = owner?.get('timezone');
      if (owner?.get('id') !== ownerId || typeof timeZone !== 'string')
        throw new Error('Proactive canary requires an owner');
      return { cursor: row?.get('cursor') ?? null, timeZone };
    },
  };
}
