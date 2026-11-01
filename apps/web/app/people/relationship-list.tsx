import type { PersonConnection, PersonRelation } from '@assistant/application/people';
import { relationSpanLabel } from '@assistant/application/people-presentation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PersonAvatar } from '@/app/people/person-avatar';
import { memoryNoteHref } from '@/lib/memory-note-context';
import { Badge } from '@/lib/ui';

const rowClass = 'flex min-w-0 items-center gap-3 rounded-xl bg-raised p-3.5 ring-1 ring-edge/60';

/**
 * The person↔person list.
 *
 * The sentence is authoritative and arrives already composed: the shared
 * presenter knows that `partner_of` is symmetric ("Élise and Marc are
 * partners") while `parent_of` is not ("Élise is Léa's parent"), and that the
 * subject of a stored edge is not always the person whose page this is. This
 * component only decides how to frame it.
 */
export function RelationshipList({
  relations,
  now,
  peopleQuery = '',
  selectedRelationId,
  editControls,
  readOnlyReasons,
}: {
  relations: PersonRelation[];
  now: Date;
  peopleQuery?: string;
  selectedRelationId?: string;
  editControls?: Record<string, ReactNode>;
  readOnlyReasons?: Record<string, { reason: string; sourceMemoryId?: string }>;
}) {
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {relations.map((relation) => {
        const normalizedId = relation.id.toLowerCase();
        const selected = normalizedId === selectedRelationId;
        // Recorded owner meaning is already present in the authoritative
        // sentence. A clock-derived duration can contradict its stated tense.
        const span = relation.assertionTiming
          ? ''
          : relationSpanLabel(relation.validFrom, relation.validUntil, now);
        const unavailable = readOnlyReasons?.[relation.id];
        const sourceHref = memoryNoteHref(
          unavailable?.sourceMemoryId ?? relation.sourceMemoryId ?? '',
          '/profile/knowledge?view=library',
        );
        const body = (
          <>
            <PersonAvatar name={relation.otherLabel} size="sm" />
            <span className="min-w-0 flex-1 text-sm leading-6 text-pretty break-words text-strong">
              {relation.sentence}
            </span>
            {span ? <span className="text-xs text-muted">{span}</span> : null}
            {relation.reviewStatus === 'unreviewed' ? (
              <Badge
                tone="muted"
                size="xs"
                title="Extracted from a fact and not yet confirmed by you."
              >
                Unreviewed
              </Badge>
            ) : null}
          </>
        );
        return (
          <li
            key={relation.id}
            id={`person-connection-${normalizedId}`}
            aria-current={selected ? 'location' : undefined}
            className={
              selected
                ? 'scroll-mt-24 rounded-xl border border-accent/25 bg-accent/[0.06] p-2'
                : undefined
            }
          >
            {relation.otherContactId ? (
              <Link
                href={`/people/${relation.otherContactId}${peopleQuery ? `?q=${encodeURIComponent(peopleQuery.slice(0, 120))}` : ''}`}
                className={`mobile-touch-target ${rowClass} motion-safe:transition-colors hover:bg-sunken/50`}
              >
                {body}
              </Link>
            ) : (
              // A person named only inside a fact has no page to open.
              <div className={rowClass}>{body}</div>
            )}
            {editControls?.[relation.id] ? (
              <div className="mt-2">{editControls[relation.id]}</div>
            ) : null}
            {!editControls?.[relation.id] && unavailable ? (
              <div className="mt-2 text-sm text-muted">
                <p>{relationshipReadOnlyMessage(unavailable.reason)}</p>
                {sourceHref ? (
                  <Link className="inline-block min-h-11 text-accent underline" href={sourceHref}>
                    Open saved source note
                  </Link>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function relationshipReadOnlyMessage(reason: string): string {
  switch (reason) {
    case 'source_note':
      return 'This connection comes from a saved note. Review that note instead of replacing the relationship here.';
    case 'shared_evidence':
      return 'This relationship has shared or multiple evidence. Its sources cannot be replaced by one edit.';
    case 'historical_source':
      return 'This relationship’s source has expired, been replaced or already corrected.';
    case 'source_dates_unverified':
      return 'The source dates cannot be preserved safely by a direct relationship edit.';
    case 'editing_unavailable':
      return 'Direct editing is unavailable in this view. Open its source note to check available corrections.';
    default:
      return 'The exact source of this relationship could not be verified for direct editing.';
  }
}

/** Connections to a place, employer, or event rather than to a person. */
export function ConnectionList({
  connections,
  now,
  selectedConnectionId,
}: {
  connections: PersonConnection[];
  now: Date;
  selectedConnectionId?: string;
}) {
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {connections.map((connection) => {
        const selected = connection.id.toLowerCase() === selectedConnectionId;
        const span = relationSpanLabel(connection.validFrom, connection.validUntil, now);
        const sourceHref = connection.sourceMemoryId
          ? memoryNoteHref(connection.sourceMemoryId, '/profile/knowledge?view=library')
          : null;
        return (
          <li
            key={connection.id}
            id={`person-connection-${connection.id.toLowerCase()}`}
            aria-current={selected ? 'location' : undefined}
            className={
              selected
                ? 'scroll-mt-24 rounded-xl border border-accent/25 bg-accent/[0.06] p-2'
                : undefined
            }
          >
            <div className={rowClass}>
              <span className="min-w-0 flex-1 text-sm leading-6 text-pretty break-words text-strong">
                {connection.sentence}
              </span>
              {span ? <span className="text-xs text-muted">{span}</span> : null}
            </div>
            {selected ? (
              <div className="mt-2 text-sm text-muted">
                <p>
                  This is a connection to {connection.otherKind}, not a relationship between people.
                  It can be reviewed here, but it cannot be edited or removed as a family
                  relationship.
                </p>
                {sourceHref ? (
                  <Link className="inline-block min-h-11 text-accent underline" href={sourceHref}>
                    Open saved source note
                  </Link>
                ) : (
                  <p>A source note link is not available for this connection.</p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
