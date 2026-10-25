import Link from 'next/link';
import { Badge, cardShellClass, MetaLine } from '@/lib/ui';
import type { FactView } from './fact-row';

/** Already-loaded source text only; no Server Action or edit component imports. */
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
      {fact.mapHref ? (
        <Link
          href={fact.mapHref}
          className="mt-3 inline-block text-sm text-accent underline underline-offset-4"
        >
          View connections
        </Link>
      ) : null}
    </article>
  );
}
