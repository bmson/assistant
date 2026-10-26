import Link from 'next/link';
import { Badge, cardShellClass, MetaLine } from '@/lib/ui';
import type { FactView } from './fact-row';

/** Already-loaded text and GET destinations; mutation authority is checked on the exact note. */
export function BrowseFact({ fact }: { fact: FactView }) {
  return (
    <article className={`${cardShellClass} min-w-0 p-4`}>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-strong">
        {fact.content}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Badge tone="muted" size="xs">
          {fact.ownerConfirmed ? 'Confirmed' : 'Unreviewed'}
        </Badge>
        <MetaLine
          segments={[
            fact.kind,
            fact.domain,
            fact.originTrust ? `Source: ${fact.originTrust}` : null,
            fact.createdLabel,
            fact.validityLabel,
            fact.subjectLabel,
          ]}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {fact.noteHref ? (
          <Link
            href={fact.noteHref}
            className="inline-block min-h-11 text-sm text-accent underline underline-offset-4"
          >
            Review / edit saved note
          </Link>
        ) : null}
        {fact.mapHref ? (
          <Link
            href={fact.mapHref}
            className="inline-block min-h-11 text-sm text-accent underline underline-offset-4"
          >
            View connections
          </Link>
        ) : null}
      </div>
    </article>
  );
}
