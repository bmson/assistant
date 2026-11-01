import Link from 'next/link';
import { entityKindLabel } from '@/lib/knowledge';
import { btn, inputClass, selectClass } from '@/lib/ui';

/** Native GET controls: opening Filters never fetches or changes the current result. */
export function ConnectionsFilters({
  query,
  kind,
  family,
  review,
  families,
  retained,
}: {
  query: string;
  kind: string;
  family: string;
  review: string;
  families: string[];
  retained: Record<string, string | number | undefined>;
}) {
  const active = Number(!!kind) + Number(!!family) + Number(review !== 'all');
  return (
    <form method="get" action="/profile/knowledge" className="mt-4 min-w-0 space-y-3">
      <input type="hidden" name="view" value="connections" />
      {Object.entries(retained)
        .filter(([key, value]) => value && !['q', 'kind', 'family', 'review'].includes(key))
        .map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={String(value)} />
        ))}
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-sm">
          Search connections
          <input name="q" maxLength={120} defaultValue={query} className={inputClass} />
        </label>
        <button className={`${btn.primary} min-h-11`} type="submit">
          Search
        </button>
        <Link href="/people" className={`${btn.outline} min-h-11`}>
          Add connection
        </Link>
      </div>
      <details className="rounded-xl border border-edge/60 px-3">
        <summary className="min-h-11 cursor-pointer content-center rounded-lg text-sm text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          Filters ({active} active)
        </summary>
        <div className="grid gap-3 pb-3 md:grid-cols-3">
          <label className="grid gap-1 text-sm">
            Item type
            <select name="kind" defaultValue={kind} className={`${selectClass} min-h-11`}>
              <option value="">All types</option>
              {['person', 'organization', 'project', 'place', 'event', 'date', 'topic'].map(
                (item) => (
                  <option key={item} value={item}>
                    {entityKindLabel(item)}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Relationship
            <select name="family" defaultValue={family} className={`${selectClass} min-h-11`}>
              <option value="">All relationships</option>
              {families.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Review status
            <select name="review" defaultValue={review} className={`${selectClass} min-h-11`}>
              <option value="all">All</option>
              <option value="confirmed">Confirmed</option>
              <option value="unreviewed">Unreviewed</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2 md:col-span-3">
            <button className={`${btn.primary} min-h-11`} type="submit">
              Apply filters
            </button>
            <Link className={`${btn.outline} min-h-11`} href="/profile/knowledge?view=connections">
              Clear filters
            </Link>
          </div>
        </div>
      </details>
    </form>
  );
}
