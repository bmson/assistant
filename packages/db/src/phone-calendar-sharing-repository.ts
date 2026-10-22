import type { PhoneCalendarSharingRepository } from '@assistant/persistence';
import {
  parsePhoneCalendarSharingState,
  parsePhoneCalendarSnapshotCache,
  phoneCalendarCacheKey,
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
    get: async (ownerId) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, ownerId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:phone-calendar-sharing:${ownerId}`}, 0))`,
        );
        const [row] = await tx
          .select({
            id: phoneCalendarSharing.id,
            agentId: phoneCalendarSharing.agentId,
            state: phoneCalendarSharing.state,
          })
          .from(phoneCalendarSharing)
          .where(eq(phoneCalendarSharing.agentId, ownerId))
          .for('share')
          .limit(1);
        if (!row) return null;
        if (row.id !== ownerId || row.agentId !== ownerId)
          throw new Error('Stored phone calendar sharing owner identity is malformed');
        const state = parsePhoneCalendarSharingState(row.state, ownerId);
        if (!state) throw new Error('Stored phone calendar sharing state is malformed');
        return state;
      }),
    readSnapshot: async (ownerId, now = new Date()) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, ownerId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:phone-calendar-sharing:${ownerId}`}, 0))`,
        );
        const [row] = await tx
          .select({
            id: phoneCalendarSharing.id,
            agentId: phoneCalendarSharing.agentId,
            state: phoneCalendarSharing.state,
          })
          .from(phoneCalendarSharing)
          .where(eq(phoneCalendarSharing.agentId, ownerId))
          .for('share')
          .limit(1);
        if (!row) return { state: null, snapshot: null };
        if (row.id !== ownerId || row.agentId !== ownerId)
          throw new Error('Stored phone calendar sharing owner identity is malformed');
        const state = parsePhoneCalendarSharingState(row.state, ownerId);
        if (!state) throw new Error('Stored phone calendar sharing state is malformed');
        const [cached] = await tx
          .select({ result: toolCache.result, expiresAt: toolCache.expiresAt })
          .from(toolCache)
          .where(eq(toolCache.cacheKey, phoneCalendarCacheKey(ownerId)))
          .limit(1);
        return {
          state,
          snapshot: parsePhoneCalendarSnapshotCache(state, cached?.result, cached?.expiresAt, now),
        };
      }),
    apply: async (ownerId, command, now = new Date()) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, ownerId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:phone-calendar-sharing:${ownerId}`}, 0))`,
        );
        const [row] = await tx
          .select({
            id: phoneCalendarSharing.id,
            agentId: phoneCalendarSharing.agentId,
            state: phoneCalendarSharing.state,
          })
          .from(phoneCalendarSharing)
          .where(eq(phoneCalendarSharing.agentId, ownerId))
          .for('update')
          .limit(1);
        if (row && (row.id !== ownerId || row.agentId !== ownerId))
          throw new Error('Stored phone calendar sharing owner identity is malformed');
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
