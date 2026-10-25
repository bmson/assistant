import { Library, Users } from 'lucide-react';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { cardInteractiveClass, PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Memory' };
export const dynamic = 'force-dynamic';

/** Static destinations require authentication, but no private data queries. */
export default async function MemoryPage() {
  await requireOwner();
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="What I remember"
        intro="Browse saved notes, people, and their connections."
      />
      <p className="mt-4 text-sm text-muted">
        Browse only. Editing and cleanup are unavailable here.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {[
          {
            href: '/people',
            title: 'People',
            detail: 'People, dates, and recorded relationships.',
            Icon: Users,
          },
          {
            href: '/profile/knowledge?view=library',
            title: 'Knowledge',
            detail: 'Saved notes and a map of their connections.',
            Icon: Library,
          },
        ].map(({ href, title, detail, Icon }) => (
          <Link key={href} href={href} className={`${cardInteractiveClass} p-5`}>
            <Icon className="size-5 text-accent" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold text-strong">{title}</h2>
            <p className="mt-1 text-sm text-muted">{detail}</p>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
