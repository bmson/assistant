import type { SettingsRepository } from '@assistant/persistence';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, notificationPrefs, proactivePings } from './schema.js';

export function createPostgresSettingsRepository(db: Db): SettingsRepository {
  return {
    kind: 'settings-repository',
    async getOwner() {
      const [row] = await db
        .select()
        .from(agents)
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(1);
      return row ?? null;
    },
    async getNotificationPrefs(agentId) {
      const [row] = await db
        .select({
          quietStartMin: notificationPrefs.quietStartMin,
          quietEndMin: notificationPrefs.quietEndMin,
          ambientDailyCap: notificationPrefs.ambientDailyCap,
        })
        .from(notificationPrefs)
        .where(eq(notificationPrefs.agentId, agentId))
        .limit(1);
      return row ?? null;
    },
    async countHeldPings(agentId, since) {
      const rows = await db
        .select({ reason: proactivePings.reason })
        .from(proactivePings)
        .where(
          and(
            eq(proactivePings.agentId, agentId),
            eq(proactivePings.delivered, false),
            gte(proactivePings.createdAt, since),
          ),
        );
      return {
        quietHours: rows.filter((row) => row.reason === 'quiet-hours').length,
        dailyCap: rows.filter((row) => row.reason === 'daily-cap').length,
      };
    },
    async updateNotificationPrefs(agentId, input) {
      const [owner] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
      if (!owner) return false;
      await db
        .insert(notificationPrefs)
        .values({ agentId, ...input })
        .onConflictDoUpdate({
          target: notificationPrefs.agentId,
          set: { ...input, updatedAt: sql`now()` },
        });
      return true;
    },
    async updateQuietHours(agentId, { quietStartMin, quietEndMin }) {
      const [owner] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
      if (!owner) return false;
      await db
        .insert(notificationPrefs)
        .values({ agentId, quietStartMin, quietEndMin })
        .onConflictDoUpdate({
          target: notificationPrefs.agentId,
          set: { quietStartMin, quietEndMin, updatedAt: sql`now()` },
        });
      return true;
    },
    async updateOwner(agentId, input) {
      const [updated] = await db
        .update(agents)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(agents.id, agentId))
        .returning({ id: agents.id });
      return Boolean(updated);
    },
  };
}
