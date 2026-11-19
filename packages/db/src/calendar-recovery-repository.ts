import {
  type CalendarRecoveryObservation,
  calendarRecoveryCursor,
  mergeCalendarRecovery,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { postgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { agents, maintenanceCursors } from './schema.js';

export async function recordPostgresCalendarRecovery(
  db: Db,
  agentId: string,
  fence: string | null,
  at: Date,
  complete: boolean,
  observations: readonly CalendarRecoveryObservation[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('no key update');
    if (!owner || (await postgresPrivacyObservationFence(tx as unknown as Db, agentId)) !== fence)
      return;
    const name = calendarRecoveryCursor(agentId);
    const [prior] = await tx
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, name));
    const cursor = mergeCalendarRecovery(prior?.cursor, fence, at, complete, observations);
    await tx
      .insert(maintenanceCursors)
      .values({ name, cursor, updatedAt: at })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor, updatedAt: at },
      });
  });
}
