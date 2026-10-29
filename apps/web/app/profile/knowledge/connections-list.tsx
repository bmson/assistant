import type { KnowledgeMapSnapshot } from '@assistant/application';
import Link from 'next/link';
import { memoryPersonEditorHref } from '@/lib/memory-editor-context';
import { memoryNoteHref } from '@/lib/memory-note-context';
import { Badge, EmptyState } from '@/lib/ui';

/** One loaded source-backed claim per row; parallel sources are not collapsed. */
export function ConnectionsList({
  snapshot,
  contextHref,
}: {
  snapshot: KnowledgeMapSnapshot;
  contextHref: string;
}) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return snapshot.edges.length ? (
    <ul className="mt-4 flex flex-col gap-3">
      {snapshot.edges.map((edge) => {
        const endpoints = [...new Set([edge.subjectId, edge.objectId])]
          .map((id) => nodes.get(id))
          .filter((node) => !!node);
        const sourceHref = memoryNoteHref(edge.sourceMemoryId, contextHref);
        const people = endpoints.flatMap((node) => {
          const href = memoryPersonEditorHref(node.contactId, contextHref);
          return href ? [{ node, href }] : [];
        });
        return (
          <li key={edge.id} className="min-w-0 rounded-xl bg-raised p-4 ring-1 ring-edge/60">
            <p className="text-sm leading-6 break-words text-strong">
              {edge.presentation.sentence}
            </p>
            {edge.reviewStatus === 'unreviewed' ? (
              <Badge tone="muted" size="xs">
                Unreviewed
              </Badge>
            ) : null}
            <p className="mt-2 text-sm text-muted">
              {people.length
                ? 'Editing and removal are unavailable from this list. Open a person to review this connection and check available changes.'
                : sourceHref
                  ? 'Editing and removal are unavailable from this list. Open the saved source note to review this connection.'
                  : 'Editing and removal are unavailable here. No linked person page or saved source note is available to review.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {people.map(({ node, href }) => (
                <Link
                  key={node.id}
                  href={href}
                  className="inline-flex min-h-11 min-w-0 items-center break-words text-accent underline"
                >
                  Open {node.label} to review
                </Link>
              ))}
              {sourceHref ? (
                <Link
                  href={sourceHref}
                  className="inline-flex min-h-11 items-center text-accent underline"
                >
                  Open saved source note
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  ) : (
    <EmptyState>No matching connections in this loaded view.</EmptyState>
  );
}
