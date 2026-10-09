'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { focusRing } from '@/lib/ui';

/** Browser navigation follows the owner console's actual reachable surfaces. */
export function AdminNavigation({ passkey }: { passkey: boolean }) {
  const pathname = usePathname();
  const links = [
    { href: '/settings', label: 'Settings' },
    ...(passkey ? [{ href: '/security', label: 'Security' }] : []),
    { href: '/audit', label: 'Audit trail' },
  ];
  return (
    <nav aria-label="Administration" className="flex min-w-0 flex-wrap items-center gap-1">
      {links.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium motion-safe:transition-colors ${active ? 'bg-sunken text-strong' : 'text-muted hover:bg-sunken/60 hover:text-strong'} ${focusRing}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
