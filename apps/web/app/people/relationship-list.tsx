import type { PersonConnection, PersonRelation } from '@assistant/application/people';
import { relationSpanLabel } from '@assistant/application/people-presentation';
import Link from 'next/link';
import { PersonAvatar } from '@/app/people/person-avatar';
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
}: {
  relations: PersonRelation[];
  now: Date;
  peopleQuery?: string;
}) {
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {relations.map((relation) => {
        const span = relationSpanLabel(relation.validFrom, relation.validUntil, now);
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
          <li key={relation.id}>
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
          </li>
        );
      })}
    </ul>
  );
}

/** Connections to a place, employer, or event rather than to a person. */
export function ConnectionList({
  connections,
  now,
}: {
  connections: PersonConnection[];
  now: Date;
}) {
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {connections.map((connection) => {
        const span = relationSpanLabel(connection.validFrom, connection.validUntil, now);
        return (
          <li key={connection.id} className={rowClass}>
            <span className="min-w-0 flex-1 text-sm leading-6 text-pretty break-words text-strong">
              {connection.sentence}
            </span>
            {span ? <span className="text-xs text-muted">{span}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
