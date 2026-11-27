import { type HouseholdHandoffRepository, householdHandoffRecord } from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { householdHandoffs, suggestions } from './schema.js';

export function createPostgresHouseholdHandoffRepository(db: Db): HouseholdHandoffRepository {
  return {
    read(agentId) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, agentId);
        const [row] = await tx
          .select()
          .from(householdHandoffs)
          .where(eq(householdHandoffs.agentId, agentId));
        return row ? householdHandoffRecord.parse(row) : null;
      });
    },
    change(expected, input) {
      const next = householdHandoffRecord.parse(input);
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, next.agentId);
        const rows =
          expected === null
            ? await tx.insert(householdHandoffs).values(next).onConflictDoNothing().returning()
            : await tx
                .update(householdHandoffs)
                .set(next)
                .where(
                  and(
                    eq(householdHandoffs.agentId, next.agentId),
                    eq(householdHandoffs.revision, expected),
                  ),
                )
                .returning();
        return rows.length === 1;
      });
    },
  };
}

export async function readPostgresAcceptedHouseholdSuggestion(
  db: Db,
  input: { agentId: string; taskId: string; suggestionId: string },
) {
  const [row] = await db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.id, input.suggestionId),
        eq(suggestions.agentId, input.agentId),
        eq(suggestions.acceptedTaskId, input.taskId),
        eq(suggestions.status, 'accepted'),
      ),
    )
    .limit(1);
  return row ?? null;
}
