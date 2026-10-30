import type { KnowledgeMapSnapshot } from '@assistant/application';
import { canAddressPersonGraphEdge } from '@assistant/application/people-graph-projection';
import Link from 'next/link';
import { memoryPersonConnectionHref, memoryPersonEditorHref } from '@/lib/memory-editor-context';
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
        const endpointIds = [...new Set([edge.subjectId, edge.objectId])];
        const sourceHref = memoryNoteHref(edge.sourceMemoryId, contextHref);
        const people = endpointIds.flatMap((id) => {
          const node = nodes.get(id);
          if (!node || node.kind !== 'person') return [];
          const otherId = id === edge.subjectId ? edge.objectId : edge.subjectId;
          const other = otherId === id ? undefined : nodes.get(otherId);
          const addressable = canAddressPersonGraphEdge({
            edgeId: edge.id,
            predicate: edge.predicate,
            outbound: id === edge.subjectId,
            validUntil: edge.validUntil,
            otherKind: other?.kind,
            reviewStatus: edge.reviewStatus,
          });
          const href = addressable
            ? memoryPersonConnectionHref(node.contactId, edge.id, contextHref)
            : memoryPersonEditorHref(node.contactId, contextHref);
          return href
            ? [
                {
                  node,
                  href,
                  addressable: addressable && href.includes('connectionId='),
                  reviewable: addressable && other?.kind === 'person',
                },
              ]
            : [];
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
              {people.some((person) => person.reviewable)
                ? 'Editing and removal are unavailable from this list. Open a person to review this connection and check available changes.'
                : people.some((person) => person.addressable)
                  ? 'This connection is read-only. Open a person to view the exact connection.'
                  : people.length
                    ? 'Editing and removal are unavailable from this list. Browse a linked person for profile context.'
                    : sourceHref
                      ? 'Editing and removal are unavailable from this list. Browse the saved source note for context.'
                      : 'Editing and removal are unavailable here. No linked person page or saved source note is available for context.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {people.map(({ node, href, addressable, reviewable }) => (
                <Link
                  key={node.id}
                  href={href}
                  className="inline-flex min-h-11 min-w-0 items-center break-words text-accent underline"
                >
                  {addressable
                    ? reviewable
                      ? `Open ${node.label} to review this connection`
                      : `Open ${node.label} to view this connection`
                    : `Browse ${node.label}`}
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
