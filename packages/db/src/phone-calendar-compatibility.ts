import {
  type PhoneCalendarCompatibilityRepository,
  parsePhoneCalendarSharingState,
  phoneCalendarCacheKey,
  phoneCalendarSharingErasureTombstone,
} from '@assistant/persistence';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';

type Query = Pick<Db, 'execute'>;

async function hasSharingTable(db: Query): Promise<boolean> {
  const rows = await db.execute(
    sql`select to_regclass('public.phone_calendar_sharing') is not null as present`,
  );
  return rows[0]?.present === true;
}

async function sharingState(db: Query, ownerId: string) {
  const rows = await db.execute(
    sql`select id, agent_id, state from public.phone_calendar_sharing where agent_id = ${ownerId} for update`,
  );
  const row = rows[0];
  if (!row) return null;
  const state = parsePhoneCalendarSharingState(row.state, ownerId);
  if (row.id !== ownerId || row.agent_id !== ownerId || !state)
    throw new Error('Phone calendar sharing ownership or state is invalid');
  return state;
}

export function createPostgresPhoneCalendarCompatibilityRepository(
  db: Db,
): PhoneCalendarCompatibilityRepository {
  return {
    read: (ownerId) =>
      db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, ownerId);
        if (!(await hasSharingTable(tx))) return { schema: 'legacy', state: null };
        return { schema: 'sharing', state: await sharingState(tx, ownerId) };
      }),
  };
}

/** Called under the existing owner/erasure transaction; migration 129 is optional. */
export async function erasePostgresPhoneCalendarSharing(db: Query, ownerId: string, now: Date) {
  if (await hasSharingTable(db)) {
    const state = phoneCalendarSharingErasureTombstone(
      ownerId,
      await sharingState(db, ownerId),
      now,
    );
    await db.execute(sql`insert into public.phone_calendar_sharing (id, agent_id, state, updated_at)
      values (${ownerId}, ${ownerId}, ${JSON.stringify(state)}::jsonb, ${now.toISOString()}::timestamptz)
      on conflict (agent_id) do update set state = excluded.state, updated_at = excluded.updated_at`);
  }
  await db.execute(sql`delete from tool_cache where cache_key = ${phoneCalendarCacheKey(ownerId)}`);
}
