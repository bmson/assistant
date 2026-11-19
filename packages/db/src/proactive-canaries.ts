import {
  PROACTIVE_CANARY_ALERT_KINDS,
  type ProactiveCanaryRepository,
  PULSE_SCHEDULE,
  proactiveSmsQuotaName,
  pulseCompletionName,
} from '@assistant/persistence';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { readPostgresBriefingHealth } from './briefing-watchdog.js';
import type { Db } from './client.js';
import { createPostgresGoogleCalendarConnectionRepository } from './google-calendar-connection-repository.js';
import { createPostgresOwnerContextRepository } from './owner-context-repository.js';
import { createPostgresPhoneCalendarSharingRepository } from './phone-calendar-sharing-repository.js';
import { createPostgresScheduleRepository } from './schedule-repository.js';
import { agents, assistantHealthAlerts, maintenanceCursors } from './schema.js';

export function createPostgresProactiveCanaryRepository(db: Db): ProactiveCanaryRepository {
  const cursor = async (name: string) => {
    const [row] = await db
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, name));
    return row;
  };
  return {
    async pulse(ownerId) {
      const schedule = await createPostgresScheduleRepository(db).getByName(
        ownerId,
        PULSE_SCHEDULE,
      );
      const row = schedule?.enabled
        ? await cursor(pulseCompletionName(ownerId, schedule.id))
        : undefined;
      return { schedule, completedAt: row?.cursor === 'postgres' ? row.updatedAt : null };
    },
    google: createPostgresGoogleCalendarConnectionRepository(db),
    phone: createPostgresPhoneCalendarSharingRepository(db),
    context: createPostgresOwnerContextRepository(db),
    briefing: (ownerId, now) => readPostgresBriefingHealth(db, now, ownerId),
    async hasOpenAlert(ownerId, since) {
      const rows = await db
        .select({ id: assistantHealthAlerts.id })
        .from(assistantHealthAlerts)
        .where(
          and(
            eq(assistantHealthAlerts.agentId, ownerId),
            eq(assistantHealthAlerts.status, 'open'),
            inArray(assistantHealthAlerts.kind, PROACTIVE_CANARY_ALERT_KINDS),
            gte(assistantHealthAlerts.lastSeenAt, since),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async sms(ownerId) {
      const [[owner], row] = await Promise.all([
        db.select({ timeZone: agents.timezone }).from(agents).where(eq(agents.id, ownerId)),
        cursor(proactiveSmsQuotaName(ownerId)),
      ]);
      if (!owner) throw new Error('Proactive canary requires an owner');
      return { cursor: row?.cursor ?? null, timeZone: owner.timeZone };
    },
  };
}
