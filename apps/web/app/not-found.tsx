import Link from 'next/link';
import { btn, PageHeader } from '@/lib/ui';

export default function NotFound() {
  return (
    <div className="mx-auto grid min-w-0 max-w-xl gap-6 py-8 sm:py-12">
      <PageHeader
        title="Page not found"
        intro="That page doesn’t exist or has moved. Return to Settings to find your way back."
      />
      <div>
        <Link href="/settings" className={btn.primary}>
          Back to settings
        </Link>
      </div>
    </div>
  );
}
