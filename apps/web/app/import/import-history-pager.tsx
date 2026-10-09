'use client';

import { useState, useTransition } from 'react';
import { loadImportHistoryPage } from '@/app/import/actions';
import { SourceCard, type SourceView, StartImportButton } from '@/app/import/source-card';
import { EmptyState, SectionHeading } from '@/lib/ui';

type Availability = { status: 'available' | 'unavailable'; message?: string };

export function ImportHistoryPager({
  initialSources,
  initialFiles,
  sourceHasMore,
  sourceCursor,
  filesHasMore,
  filesCursor,
  sourceAvailability,
  filesAvailability,
}: {
  initialSources: SourceView[];
  initialFiles: Array<{ name: string; dir: boolean }>;
  sourceHasMore: boolean;
  sourceCursor: string | null;
  filesHasMore: boolean;
  filesCursor: string | null;
  sourceAvailability: Availability;
  filesAvailability: Availability;
}) {
  const [sources, setSources] = useState(initialSources);
  const [files, setFiles] = useState(initialFiles);
  const [sourcePage, setSourcePage] = useState({ hasMore: sourceHasMore, cursor: sourceCursor });
  const [filePage, setFilePage] = useState({ hasMore: filesHasMore, cursor: filesCursor });
  const [sourceError, setSourceError] = useState<string | null>(
    sourceAvailability.status === 'unavailable'
      ? (sourceAvailability.message ?? 'Import history is unavailable.')
      : null,
  );
  const [fileError, setFileError] = useState<string | null>(
    filesAvailability.status === 'unavailable'
      ? (filesAvailability.message ?? 'Workspace files are unavailable.')
      : null,
  );
  const [sourcesPending, startSourcesTransition] = useTransition();
  const [filesPending, startFilesTransition] = useTransition();

  const load = (stream: 'sources' | 'files') => {
    const page = stream === 'sources' ? sourcePage : filePage;
    const pending = stream === 'sources' ? sourcesPending : filesPending;
    const startTransition = stream === 'sources' ? startSourcesTransition : startFilesTransition;
    if (!page.hasMore || !page.cursor || pending) return;
    startTransition(async () => {
      try {
        const response = await loadImportHistoryPage(stream, page.cursor as string);
        if (response.stream === 'sources') {
          setSources((current) => {
            const seen = new Set(current.map((row) => row.source));
            return [...current, ...response.items.filter((row) => !seen.has(row.source))];
          });
          setSourcePage({ hasMore: response.hasMore, cursor: response.nextCursor });
          setSourceError(null);
        } else {
          setFiles((current) => {
            const seen = new Set(current.map((row) => row.name));
            return [...current, ...response.items.filter((row) => !seen.has(row.name))];
          });
          setFilePage({ hasMore: response.hasMore, cursor: response.nextCursor });
          setFileError(null);
        }
      } catch {
        const message = 'Couldn’t load more items. Check your connection and try again.';
        if (stream === 'sources') setSourceError(message);
        else setFileError(message);
      }
    });
  };

  return (
    <>
      <section className="mt-8">
        <SectionHeading
          title="Files ready to import"
          hint={
            files.length
              ? `${files.length} loaded${filePage.hasMore ? ' · more available' : ''}`
              : undefined
          }
        />
        {fileError ? (
          <p role="status" className="mt-3 text-sm text-red-700">
            {fileError}
          </p>
        ) : null}
        {filesAvailability.status === 'available' && files.length === 0 && !filePage.hasMore ? (
          <EmptyState>No unstarted files found.</EmptyState>
        ) : null}
        {files.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {files.map((file) => (
              <div
                key={file.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
              >
                <p className="min-w-0 truncate text-sm">{file.name}</p>
                <StartImportButton
                  path={`import/${file.name}`}
                  suggestedTag={file.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase()}
                />
              </div>
            ))}
          </div>
        ) : null}
        {filePage.hasMore ? (
          <button
            type="button"
            className="mt-3 rounded-lg border border-edge px-3 py-2 text-sm"
            disabled={filesPending}
            onClick={() => load('files')}
          >
            {filesPending ? 'Loading…' : 'Load more files'}
          </button>
        ) : null}
      </section>

      <section className="mt-8">
        <SectionHeading
          title="Import history"
          hint={
            sources.length
              ? `${sources.length} loaded${sourcePage.hasMore ? ' · more available' : ''}`
              : undefined
          }
        />
        {sourceError ? (
          <p role="status" className="mt-3 text-sm text-red-700">
            {sourceError}
          </p>
        ) : null}
        {sourceAvailability.status === 'available' &&
        sources.length === 0 &&
        !sourcePage.hasMore ? (
          <EmptyState>Nothing imported yet.</EmptyState>
        ) : null}
        {sources.length > 0 ? (
          <div className="mt-3 flex flex-col gap-3">
            {sources.map((row) => (
              <SourceCard key={row.source} view={row} />
            ))}
          </div>
        ) : null}
        {sourcePage.hasMore ? (
          <button
            type="button"
            className="mt-3 rounded-lg border border-edge px-3 py-2 text-sm"
            disabled={sourcesPending}
            onClick={() => load('sources')}
          >
            {sourcesPending ? 'Loading…' : 'Load more history'}
          </button>
        ) : null}
      </section>
    </>
  );
}
