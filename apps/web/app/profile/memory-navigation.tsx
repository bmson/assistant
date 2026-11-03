import Link from 'next/link';
import {
  focusRing,
  segmentedControlClass,
  segmentedItemActiveClass,
  segmentedItemClass,
} from '@/lib/ui';

export function MemoryNavigation({
  current,
  notesHref = '/profile/knowledge?view=library',
  connectionsHref = '/profile/knowledge?view=connections',
  mapHref = '/profile/knowledge?view=map',
}: {
  current?: 'notes' | 'people' | 'connections' | 'map';
  notesHref?: string;
  connectionsHref?: string;
  mapHref?: string;
}) {
  const items = [
    { id: 'notes', label: 'Saved notes', href: notesHref },
    { id: 'people', label: 'People', href: '/people' },
    { id: 'connections', label: 'Connections', href: connectionsHref },
  ] as const;

  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <nav aria-label="Memory" className={`${segmentedControlClass} flex-wrap`}>
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={current === item.id ? 'page' : undefined}
            className={current === item.id ? segmentedItemActiveClass : segmentedItemClass}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Link
        href={mapHref}
        aria-current={current === 'map' ? 'page' : undefined}
        className={`mobile-touch-target inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium ${current === 'map' ? 'text-accent' : 'text-muted'} underline-offset-4 hover:text-strong hover:underline ${focusRing}`}
      >
        Map
      </Link>
    </div>
  );
}
