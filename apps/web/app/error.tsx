'use client';

import Link from 'next/link';
import { btn, PageHeader } from '@/lib/ui';

/** Route error boundary — friendly, no stack traces or internal detail leaked. */
export default function RouteError({ retry }: { error: Error; retry: () => void }) {
  return (
    <div className="mx-auto grid min-w-0 max-w-xl gap-6 py-8 sm:py-12">
      <PageHeader
        title="Couldn’t load this page"
        intro="Check your connection and try again. You can also return to Settings."
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" onClick={retry} className={btn.primary}>
          Try again
        </button>
        <Link href="/settings" className={btn.outline}>
          Back to settings
        </Link>
      </div>
    </div>
  );
}
