import Link from 'next/link';
import { segmentedControlClass, segmentedItemActiveClass, segmentedItemClass } from '@/lib/ui';

export function MemoryNavigation({ current }: { current?: 'notes' | 'people' | 'connections' }) {
  return (
    <nav aria-label="Memory" className={`${segmentedControlClass} mt-5 flex-wrap`}>
      {[
        { id: 'notes', label: 'Saved notes', href: '/profile/knowledge?view=library' },
        { id: 'people', label: 'People', href: '/people' },
        { id: 'connections', label: 'Connections', href: '/profile/knowledge?view=connections' },
      ].map((item) => (
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
  );
}
