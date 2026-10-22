import type { PhoneCalendarSharingRepository } from '@assistant/persistence';
import {
  parsePhoneCalendarSharingState,
  phoneCalendarCacheRecord,
  transitionPhoneCalendarSharing,
} from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { phoneCalendarSharing, toolCache } from './schema.js';

export function createPostgresPhoneCalendarSharingRepository(
  db: Db,
): PhoneCalendarSharingRepository {
  return {
    get: async (ownerId) => {
      const [row] = await db
        .select({ state: phoneCalendarSharing.state })
        .from(phoneCalendarSharing)
        .where(eq(phoneCalendarSharing.agentId, ownerId))
        .limit(1);
      if (!row) return null;
      const state = parsePhoneCalendarSharingState(row.state, ownerId);
      if (!state) throw new Error('Stored phone calendar sharing state is malformed');
      return state;
    },
    apply: async (ownerId, command, now = new Date()) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, ownerId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:phone-calendar-sharing:${ownerId}`}, 0))`,
        );
        const [row] = await tx
          .select({ state: phoneCalendarSharing.state })
          .from(phoneCalendarSharing)
          .where(eq(phoneCalendarSharing.agentId, ownerId))
          .for('update')
          .limit(1);
        const current = row ? parsePhoneCalendarSharingState(row.state, ownerId) : null;
        if (row && !current) throw new Error('Stored phone calendar sharing state is malformed');
        const transition = transitionPhoneCalendarSharing(ownerId, current, command, now);
        if (!transition.result.ok) return transition.result;

        await tx
          .insert(phoneCalendarSharing)
          .values({
            id: ownerId,
            agentId: ownerId,
            state: transition.result.state,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: phoneCalendarSharing.agentId,
            set: { state: transition.result.state, updatedAt: now },
          });

        if (transition.snapshot !== undefined) {
          const record = phoneCalendarCacheRecord(ownerId, transition.snapshot, now);
          await tx
            .insert(toolCache)
            .values({ ...record, result: record.result as Record<string, unknown> })
            .onConflictDoUpdate({
              target: toolCache.cacheKey,
              set: {
                toolName: record.toolName,
                result: record.result as Record<string, unknown>,
                expiresAt: record.expiresAt,
              },
            });
        }
        return transition.result;
      }),
  };
}
