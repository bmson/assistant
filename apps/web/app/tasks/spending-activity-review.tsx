import Link from 'next/link';
import { spendingRequestHref } from '@/app/costs/pending-spending-overview';

export function SpendingActivityReview({
  status,
  operationId,
}: {
  status: string;
  operationId?: string | null;
}) {
  if (status !== 'waiting_estimated_cost') return null;
  if (!operationId) {
    return (
      <p className="mt-2 text-sm text-muted">
        This spending request cannot be opened from this activity.
      </p>
    );
  }
  return (
    <Link
      className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-accent hover:underline"
      href={spendingRequestHref(operationId)}
    >
      Review spending request
    </Link>
  );
}
