import { getImportOverview, type ImportSourceSnapshot } from '@assistant/application/imports';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  FirestoreImportOverviewRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { ImportHistoryPager } from '@/app/import/import-history-pager';
import type { SourceView } from '@/app/import/source-card';
import { UploadPanel } from '@/app/upload-panel';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getApplication, getWorkspace } from '@/lib/server';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Import' };

export const dynamic = 'force-dynamic';

async function getFirestorePageImports() {
  const config = loadConfig();
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    const configured = await store.collection('agents').limit(2).get();
    if (configured.size !== 1 || configured.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID)
      throw new Error('Import overview requires one matching configured owner');
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    const overview = await getImportOverview(
      new FirestoreImportOverviewRepository(store, config.FIRESTORE_AGENT_ID),
      getWorkspace(),
    );
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    return overview;
  } finally {
    await store.db.terminate();
  }
}

function toView(row: ImportSourceSnapshot, quarantinedNow: number, now: Date): SourceView {
  return {
    source: row.source,
    workspacePath: row.workspacePath,
    kind: row.kind,
    status: row.status,
    itemsTotal: row.itemsTotal,
    itemsProcessed: row.itemsProcessed,
    memoriesSaved: row.memoriesSaved,
    quarantinedNow,
    taskId: row.taskId,
    error: row.error,
    updatedLabel: `updated ${relativeTime(row.updatedAt, now)}`,
  };
}

export default async function ImportPage() {
  await requireOwner();
  const now = new Date();
  const overview =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await getFirestorePageImports()
      : await getApplication().getImports();
  const sources = overview.sources;

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/documents', label: 'Documents' }}
        title="Backstory import"
        intro="Add email archives, chat exports, or notes to help the assistant understand your history. You can review anything it learns about other people before it is remembered."
      />

      {/* Upload */}
      <UploadPanel
        className="mt-8"
        title="Upload an archive"
        action="/api/import/upload"
        submitLabel="Upload and import"
        labelSummary="Choose a custom label"
        labelName="source"
        labelCaption="Label"
        labelPlaceholder="For example, old work email"
        hint={
          <>
            Files can be up to 25MB. For larger archives, add the file to{' '}
            <code className="rounded bg-sunken px-1">import/</code> and start them from the list
            below.
          </>
        }
      />

      <ImportHistoryPager
        initialSources={sources.map((row) =>
          toView(row, overview.quarantineBySource[row.source] ?? 0, now),
        )}
        initialFiles={overview.unstartedFiles}
        sourceHasMore={overview.sourcePagination.hasMore}
        sourceCursor={overview.sourcePagination.nextCursor}
        filesHasMore={overview.filesPagination.hasMore}
        filesCursor={overview.filesPagination.nextCursor}
        sourceAvailability={overview.sourceAvailability}
        filesAvailability={overview.filesAvailability}
      />
    </PageShell>
  );
}
