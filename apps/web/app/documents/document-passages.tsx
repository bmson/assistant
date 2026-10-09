'use client';

import { useState } from 'react';
import { mergeDocumentPassagePage, type RenderedDocumentChunk } from '@/lib/document-passage-state';
import { btn } from '@/lib/ui';

type Chunk = RenderedDocumentChunk;
type PageResponse = { chunks: Chunk[]; nextCursor: number | string | null; totalChunks: number };

export function DocumentPassages({ documentId, total }: { documentId: string; total: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [nextCursor, setNextCursor] = useState<number | string | null>(0);
  const [knownTotal, setKnownTotal] = useState(total);
  const [error, setError] = useState<string | null>(null);

  async function load(cursor: number | string) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}?cursor=${encodeURIComponent(cursor)}&limit=50`,
        { cache: 'no-store' },
      );
      const payload = (await response.json()) as PageResponse & {
        error?: string | { code?: string; message?: string; chunkIndex?: number };
      };
      if (!response.ok) {
        if (response.status === 409 && typeof payload.error === 'object') {
          setChunks([]);
          setNextCursor(0);
          throw new Error(
            'This passage changed. Hide and reopen passages to load the current text.',
          );
        }
        const detail = typeof payload.error === 'object' ? payload.error.message : payload.error;
        throw new Error(detail || 'Document passages could not be loaded.');
      }
      setChunks(mergeDocumentPassagePage(chunks, payload.chunks));
      setNextCursor(payload.nextCursor);
      setKnownTotal(payload.totalChunks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Document passages could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-3">
      <button
        type="button"
        className={`${btn.outline} min-h-10`}
        aria-expanded={open}
        aria-controls={`document-passages-${documentId}`}
        onClick={() => {
          const expanding = !open;
          setOpen(expanding);
          if (expanding && chunks.length === 0) void load(0);
        }}
      >
        {open ? 'Hide passages' : 'Read passages'}
      </button>
      {open ? (
        <div id={`document-passages-${documentId}`} className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            Showing {chunks.length} of {knownTotal} passages.
          </p>
          {chunks.map((chunk) => (
            <article
              key={chunk.chunkIndex}
              className="rounded-xl border border-border bg-sunken/40 px-3 py-2.5"
            >
              <h4 className="text-xs font-medium text-muted">Passage {chunk.chunkIndex + 1}</h4>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                {chunk.text}
              </p>
              {chunk.fragment && !chunk.fragment.complete ? (
                <p className="mt-1 text-xs text-muted">Continuing this passage…</p>
              ) : null}
            </article>
          ))}
          {error ? (
            <p role="status" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
          {nextCursor !== null && !error ? (
            <button
              type="button"
              className={btn.outline}
              disabled={loading}
              onClick={() => void load(nextCursor)}
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
