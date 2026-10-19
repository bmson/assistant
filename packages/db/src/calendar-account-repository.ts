import type { CalendarAccountRepository } from '@assistant/persistence';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { calendarAccounts } from './schema.js';

export function createPostgresCalendarAccountRepository(db: Db): CalendarAccountRepository {
  return {
    list: () => db.select().from(calendarAccounts).orderBy(asc(calendarAccounts.email)),
    async save(account) {
      await db.insert(calendarAccounts).values(account).onConflictDoUpdate({
        target: calendarAccounts.id,
        set: account,
      });
    },
    async remove(id) {
      await db.delete(calendarAccounts).where(eq(calendarAccounts.id, id));
    },
    async recordError(id, credential, lastError) {
      await db
        .update(calendarAccounts)
        .set({ lastError })
        .where(
          and(eq(calendarAccounts.id, id), eq(calendarAccounts.refreshTokenEncrypted, credential)),
        );
    },
  };
}
