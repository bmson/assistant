import { parseOwnerEditorEpochCursor } from '@assistant/persistence';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { maintenanceCursors, ownerEditorOperations } from './schema.js';

const replayMs = 24 * 60 * 60 * 1000;
const pageSize = 64;
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;
function retentionCutoff(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Editor receipt retention time is invalid');
  const actualNow = Date.now();
  if (!Number.isFinite(actualNow)) throw new Error('Editor receipt retention clock is invalid');
  // Caller time must never advance deletion ahead of the authoritative replay clock.
  return new Date(actualNow - replayMs);
}

/**
 * Removes at most one owner-scoped page of replay-expired receipts.
 * Call repeatedly from maintenance until this returns zero. This never
 * interprets a missing receipt as evidence that an operation was not applied.
 */
export async function pruneExpiredPostgresOwnerEditorReceipts(
  db: Db,
  ownerId: string,
  now: Date,
): Promise<number> {
  const cutoff = retentionCutoff(now);
  return db.transaction(async (tx) => {
    // Match operation writers and privacy erasure: owner/privacy fence first.
    await lockPostgresPrivacyObservationFence(tx, ownerId);
    await assertPostgresInstallationOwner(tx as unknown as Db, ownerId);

    // A missing epoch is allowed for cleanup, but an existing epoch must be
    // strictly owner-bound and locked before receipt rows are read or deleted.
    const [epoch] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, epochName(ownerId)))
      .for('update')
      .limit(1);
    if (epoch) {
      const parsed = parseOwnerEditorEpochCursor(JSON.parse(epoch.cursor ?? 'null'));
      if (parsed.ownerId !== ownerId) throw new Error('Editor epoch owner is unavailable');
    }

    const expired = await tx
      .select({
        id: ownerEditorOperations.id,
        ownerId: ownerEditorOperations.ownerId,
        formIssuedAt: ownerEditorOperations.formIssuedAt,
      })
      .from(ownerEditorOperations)
      .where(
        and(
          eq(ownerEditorOperations.ownerId, ownerId),
          lte(ownerEditorOperations.formIssuedAt, cutoff),
        ),
      )
      .orderBy(asc(ownerEditorOperations.formIssuedAt), asc(ownerEditorOperations.id))
      .limit(pageSize)
      .for('update');
    if (expired.length === 0) return 0;
    if (
      expired.some(
        (row) =>
          row.ownerId !== ownerId ||
          typeof row.id !== 'string' ||
          !(row.formIssuedAt instanceof Date) ||
          !Number.isFinite(row.formIssuedAt.getTime()) ||
          row.formIssuedAt.getTime() > cutoff.getTime(),
      )
    )
      throw new Error('Editor receipt retention selection is invalid');

    const ids = expired.map((row) => row.id);
    await tx
      .delete(ownerEditorOperations)
      .where(
        and(eq(ownerEditorOperations.ownerId, ownerId), inArray(ownerEditorOperations.id, ids)),
      );
    return ids.length;
  });
}
