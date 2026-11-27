import { type SavedPlacesRepository, savedPlaceRecord } from '@assistant/persistence';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { savedPlaces } from './schema.js';

export function createPostgresSavedPlacesRepository(db: Db): SavedPlacesRepository {
  return {
    list(agentId) {
      return db.transaction(async (tx) => {
        const generation = await lockPostgresPrivacyObservationFence(tx, agentId);
        const rows = await tx
          .select()
          .from(savedPlaces)
          .where(and(eq(savedPlaces.agentId, agentId), isNotNull(savedPlaces.details)));
        return {
          generation,
          places: rows
            .map((row) => savedPlaceRecord.parse(row))
            .flatMap(({ id, revision, details }) => (details ? [{ id, revision, details }] : [])),
        };
      });
    },
    read(agentId, id, observed) {
      return db.transaction(async (tx) => {
        if ((await lockPostgresPrivacyObservationFence(tx, agentId)) !== observed) return null;
        const [row] = await tx
          .select()
          .from(savedPlaces)
          .where(and(eq(savedPlaces.agentId, agentId), eq(savedPlaces.id, id)));
        return row ? savedPlaceRecord.parse(row) : null;
      });
    },
    change(agentId, { id, generation, expectedRevision, revision, details }) {
      return db.transaction(async (tx) => {
        if ((await lockPostgresPrivacyObservationFence(tx, agentId)) !== generation) return false;
        if (expectedRevision === null) {
          const rows = await tx
            .insert(savedPlaces)
            .values({ id, agentId, revision, details })
            .onConflictDoNothing()
            .returning({ id: savedPlaces.id });
          return rows.length === 1;
        }
        const rows = await tx
          .update(savedPlaces)
          .set({ revision, details })
          .where(
            and(
              eq(savedPlaces.agentId, agentId),
              eq(savedPlaces.id, id),
              eq(savedPlaces.revision, expectedRevision),
              isNotNull(savedPlaces.details),
            ),
          )
          .returning({ id: savedPlaces.id });
        return rows.length === 1;
      });
    },
  };
}
