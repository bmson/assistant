'use client';

import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  Badge,
  type BadgeTone,
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  MetaLine,
} from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';
import { purgeDocumentAction } from './actions';
import { DocumentPassages } from './document-passages';

export interface DocumentCardView {
  id: string;
  title: string;
  mime: string;
  source: string;
  trust: string;
  status: string;
  extractor: string;
  chunkCount: number;
  bytesLabel: string;
  error: string | null;
  createdLabel: string;
  askHref: string;
}

// Queued is neutral, not amber — a document waiting its turn asks nothing of
// the owner, and amber is reserved for things that do.
const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  ready: { label: 'Ready', tone: 'green' },
  extracting: { label: 'Reading…', tone: 'accent' },
  pending: { label: 'Queued', tone: 'neutral' },
  unsupported: { label: 'Unsupported', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'red' },
};

export function DocumentCard({ doc }: { doc: DocumentCardView }) {
  const [pending, startTransition] = useTransition();
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const status = STATUS[doc.status] ?? STATUS.pending;
  // A queued heavy format (scan/office/audio) waits for the document processor.
  const waitingForProcessor = doc.status === 'pending' && doc.extractor === 'pending_processor';
  const sourceLabel =
    doc.source === 'email' ? 'Email attachment' : doc.source === 'drive' ? 'Drive' : 'Upload';
  const formatLabel = doc.mime.split('/').pop()?.toUpperCase() ?? doc.mime;

  return (
    <article className={`${cardShellClass} flex h-full flex-col`}>
      <div className={`${cardBodyClass} flex-1`}>
        <div className={cardHeaderClass}>
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className={`truncate ${cardTitleClass}`}>{doc.title}</h3>
              <p className="mt-0.5 text-xs text-muted">
                {sourceLabel}
                {doc.trust !== 'owner' ? ' · Third-party source' : ''}
              </p>
            </div>
          </div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>

        <MetaLine
          segments={[
            formatLabel,
            doc.bytesLabel,
            `Added ${doc.createdLabel}`,
            doc.status === 'ready'
              ? `${doc.chunkCount} searchable passage${doc.chunkCount === 1 ? '' : 's'}`
              : 'Not searchable yet',
          ]}
        />
        {doc.status === 'ready' && doc.chunkCount > 0 ? (
          <DocumentPassages documentId={doc.id} total={doc.chunkCount} />
        ) : null}

        {waitingForProcessor ? (
          <p className="rounded-xl bg-sunken/65 px-3 py-2.5 text-xs leading-5 text-muted">
            Waiting for the document processor to read this format.
          </p>
        ) : null}
        {doc.status === 'failed' && doc.error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {doc.error}
          </p>
        ) : null}
        {deleteNotice ? (
          <p
            role="status"
            className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:bg-amber-950/35 dark:text-amber-200"
          >
            {deleteNotice}
          </p>
        ) : null}
      </div>
      <footer className={cardFooterClass}>
        {doc.status === 'ready' && !deleteNotice ? (
          <Link href={doc.askHref} className={btn.outline}>
            Ask about this
          </Link>
        ) : null}
        <ConfirmButton
          pending={pending}
          pendingLabel="Deleting…"
          confirmLabel={deleteNotice ? 'Retry delete?' : 'Delete?'}
          onConfirm={() =>
            startTransition(async () => {
              const result = await purgeDocumentAction(doc.id);
              setDeleteNotice(
                result?.pendingAssets
                  ? 'Removed from search. Stored bytes are still being deleted; try Delete again to retry.'
                  : null,
              );
            })
          }
        >
          {deleteNotice ? 'Retry deletion' : 'Delete'}
        </ConfirmButton>
      </footer>
    </article>
  );
}
