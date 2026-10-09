'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getCurrentImportOverview, getImportCommands } from '@/lib/server';
import type { SourceView } from './source-card';

function revalidateImport(): void {
  revalidatePath('/import');
  revalidatePath('/profile');
  revalidatePath('/profile/voice');
}

/** Start (or re-run) an import for a file already under workspace import/. */
export async function startImportAction(
  workspacePath: string,
  sourceTag: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getImportCommands().startImport(workspacePath, sourceTag);
  if (result.error) return result;
  revalidateImport();
  return {};
}

/** Bound form action: purge every memory this source produced. */
export async function purgeSourceAction(source: string): Promise<void> {
  await requireOwner();
  await getImportCommands().purgeImport(source);
  revalidateImport();
}

/** Remove the source entirely: memories, uploaded file, and the row itself. */
export async function deleteSourceAction(source: string): Promise<void> {
  await requireOwner();
  await getImportCommands().deleteImport(source);
  revalidateImport();
}

export async function reviewSourceAction(
  source: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  await getImportCommands().reviewImport(source, verdict);
  revalidateImport();
}

export async function loadImportHistoryPage(
  stream: 'sources' | 'files',
  cursor: string,
): Promise<
  | { stream: 'sources'; items: SourceView[]; hasMore: boolean; nextCursor: string | null }
  | {
      stream: 'files';
      items: Array<{ name: string; dir: boolean }>;
      hasMore: boolean;
      nextCursor: string | null;
    }
> {
  await requireOwner();
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 8192)
    throw new Error('Invalid import history continuation');
  const overview = await getCurrentImportOverview({
    ...(stream === 'sources' ? { sourceCursor: cursor } : { filesCursor: cursor }),
    limit: 50,
  });
  if (stream === 'sources') {
    if (overview.sourceAvailability.status !== 'available')
      throw new Error(overview.sourceAvailability.message ?? 'Import history is unavailable');
    return {
      stream,
      items: overview.sources.map((row) => ({
        source: row.source,
        workspacePath: row.workspacePath,
        kind: row.kind,
        status: row.status,
        itemsTotal: row.itemsTotal,
        itemsProcessed: row.itemsProcessed,
        memoriesSaved: row.memoriesSaved,
        quarantinedNow: overview.quarantineBySource[row.source] ?? 0,
        taskId: row.taskId,
        error: row.error,
        updatedLabel: `updated ${relativeTime(row.updatedAt, new Date())}`,
      })),
      hasMore: overview.sourcePagination.hasMore,
      nextCursor: overview.sourcePagination.nextCursor,
    };
  }
  if (overview.filesAvailability.status !== 'available')
    throw new Error(overview.filesAvailability.message ?? 'Workspace files are unavailable');
  return {
    stream,
    items: overview.unstartedFiles,
    hasMore: overview.filesPagination.hasMore,
    nextCursor: overview.filesPagination.nextCursor,
  };
}
