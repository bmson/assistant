import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  type GoogleCalendarConnectionRepository,
  parseGoogleCalendarConnection,
} from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { googleCalendarConnections } from './schema.js';

export function createPostgresGoogleCalendarConnectionRepository(
  db: Db,
): GoogleCalendarConnectionRepository {
  return createGoogleCalendarConnectionRepository({
    async read(ownerId) {
      const [row] = await db
        .select()
        .from(googleCalendarConnections)
        .where(eq(googleCalendarConnections.agentId, ownerId))
        .limit(1);
      return row ? parseGoogleCalendarConnection(row.state, ownerId) : null;
    },
    update: (ownerId, change) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:google-calendar:${ownerId}`}, 0))`,
        );
        const [row] = await tx
          .select()
          .from(googleCalendarConnections)
          .where(eq(googleCalendarConnections.agentId, ownerId))
          .for('update')
          .limit(1);
        const { state, result } = change(
          row
            ? parseGoogleCalendarConnection(row.state, ownerId)
            : emptyGoogleCalendarConnection(ownerId),
        );
        parseGoogleCalendarConnection(state, ownerId);
        await tx
          .insert(googleCalendarConnections)
          .values({ agentId: ownerId, state })
          .onConflictDoUpdate({
            target: googleCalendarConnections.agentId,
            set: { state, updatedAt: sql`now()` },
          });
        return result;
      }),
  });
}
