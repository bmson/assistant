import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  type GoogleCalendarConnectionRepository,
  parseGoogleCalendarConnection,
  readHouseholdCalendarSettings,
} from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { googleCalendarConnections, googleHouseholdCalendarChoices } from './schema.js';

async function readConnection(db: Pick<Db, 'select'>, ownerId: string) {
  const [row] = await db
    .select({
      state: googleCalendarConnections.state,
      settings: googleHouseholdCalendarChoices.settings,
    })
    .from(googleCalendarConnections)
    .leftJoin(
      googleHouseholdCalendarChoices,
      eq(googleHouseholdCalendarChoices.agentId, googleCalendarConnections.agentId),
    )
    .where(eq(googleCalendarConnections.agentId, ownerId))
    .limit(1);
  if (!row) return null;
  const state = parseGoogleCalendarConnection(row.state, ownerId);
  const household = readHouseholdCalendarSettings(row.settings, state.connection?.id);
  return { ...state, ...(household ? { household } : {}) };
}

export function createPostgresGoogleCalendarConnectionRepository(
  db: Db,
): GoogleCalendarConnectionRepository {
  return createGoogleCalendarConnectionRepository({
    read: (ownerId) => readConnection(db, ownerId),
    update: (ownerId, change) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:google-calendar:${ownerId}`}, 0))`,
        );
        const prior = await readConnection(tx, ownerId);
        const {
          state: { household, ...state },
          result,
        } = change(prior ?? emptyGoogleCalendarConnection(ownerId));
        parseGoogleCalendarConnection(state, ownerId);
        await tx
          .insert(googleCalendarConnections)
          .values({ agentId: ownerId, state })
          .onConflictDoUpdate({
            target: googleCalendarConnections.agentId,
            set: { state, updatedAt: sql`now()` },
          });
        if (
          household &&
          state.connection &&
          (prior?.household !== household || prior.connection?.id !== state.connection.id)
        ) {
          const settings = { ...household, connectionId: state.connection.id };
          await tx
            .insert(googleHouseholdCalendarChoices)
            .values({ agentId: ownerId, settings })
            .onConflictDoUpdate({
              target: googleHouseholdCalendarChoices.agentId,
              set: { settings },
            });
        } else if (!state.connection) {
          await tx
            .delete(googleHouseholdCalendarChoices)
            .where(eq(googleHouseholdCalendarChoices.agentId, ownerId));
        }
        return result;
      }),
  });
}
