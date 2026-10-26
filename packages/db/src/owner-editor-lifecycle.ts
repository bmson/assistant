import { randomUUID } from 'node:crypto';
import {
  ownerEditorEpochCursorWithoutMaintenanceBinder,
  ownerEditorPrivacyDigest,
  parseOwnerEditorEpochCursor,
} from '@assistant/persistence';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { maintenanceCursors, ownerEditorOperations } from './schema.js';

type Tx = Pick<Db, 'select' | 'update' | 'delete'>;
/** Caller holds the owner erasure lock. Never enables a previously disabled/missing editor. */
export async function rotateExistingPostgresEditorForErasure(
  tx: Tx,
  ownerId: string,
  privacyGeneration?: string | null,
): Promise<void> {
  const name = `owner-editor-epoch:${ownerId}`;
  const [row] = await tx
    .select()
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, name))
    .for('update')
    .limit(1);
  if (!row) return;
  const current = parseOwnerEditorEpochCursor(JSON.parse(row.cursor ?? 'null'));
  if (current.ownerId !== ownerId) throw new Error('Editor epoch owner mismatch');
  await tx
    .update(maintenanceCursors)
    .set({
      cursor: JSON.stringify({
        ...ownerEditorEpochCursorWithoutMaintenanceBinder(current),
        epoch: randomUUID(),
        ...(privacyGeneration !== undefined
          ? { privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration) }
          : {}),
      }),
      updatedAt: new Date(),
    })
    .where(eq(maintenanceCursors.name, name));
}

/** Owner fence remains active across pages; late workers cannot recreate these private receipts. */
export async function erasePostgresEditorReceiptPage(tx: Tx, ownerId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: ownerEditorOperations.id })
    .from(ownerEditorOperations)
    .where(eq(ownerEditorOperations.ownerId, ownerId))
    .orderBy(asc(ownerEditorOperations.id))
    .limit(64)
    .for('update');
  if (!rows.length) return true;
  await tx.delete(ownerEditorOperations).where(
    and(
      eq(ownerEditorOperations.ownerId, ownerId),
      inArray(
        ownerEditorOperations.id,
        rows.map((row) => row.id),
      ),
    ),
  );
  return false;
}
