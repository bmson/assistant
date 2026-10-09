'use server';

import { deleteDocument } from '@assistant/application/documents';
import { isModuleEnabled, loadConfig } from '@assistant/config';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { getApplication, getWorkspace } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delete a document: its chunks, the row, the file inventory, and the bytes. */
export async function purgeDocumentAction(
  id: string,
): Promise<{ deleted: boolean; pendingAssets: boolean } | undefined> {
  await requireOwner();
  if (!isModuleEnabled(loadConfig(), 'documents')) return;
  if (!UUID_RE.test(id)) return;
  let result: { deleted: boolean; pendingAssets: boolean };
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    result = await deleteDocument(getFirestoreDocumentStores(), getWorkspace(), id);
  else result = await getApplication().deleteDocument(id);
  if (!result.pendingAssets) revalidatePath('/documents');
  return result;
}
