import type {
  EstimatedCostOverviewResponse,
  EstimatedCostRequestProjection,
} from '@assistant/persistence';
import Link from 'next/link';
import { formatCostMicros } from '@/app/chat/[id]/estimated-cost-decision';
import { cardShellClass } from '@/lib/ui';

export function spendingRequestHref(operationId: string): string {
  return `/costs/requests/${encodeURIComponent(operationId)}`;
}

function amount(value: number | null): string {
  return value === null ? 'Unavailable' : formatCostMicros(value);
}

function requestStatus(status: EstimatedCostRequestProjection['status']): string {
  switch (status) {
    case 'pending':
      return 'Awaiting approval';
    case 'expired_or_needs_refresh':
      return 'Estimate needs refreshing';
    case 'unavailable':
      return 'Status unavailable';
    case 'approved':
      return 'Approved';
    case 'declined':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function PendingSpendingOverview({
  overview,
}: {
  overview: EstimatedCostOverviewResponse | null;
}) {
  if (!overview?.ok) {
    return (
      <section className={`${cardShellClass} mt-6`} aria-labelledby="pending-spending-heading">
        <h2 id="pending-spending-heading" className="border-b border-edge px-5 py-4 font-semibold">
          Planned spending
        </h2>
        <p className="px-5 py-4 text-sm text-muted" role="status">
          Current planned spending is unavailable.
        </p>
      </section>
    );
  }
  const { tracking, requests } = overview;
  return (
    <section className={`${cardShellClass} mt-6`} aria-labelledby="pending-spending-heading">
      <h2 id="pending-spending-heading" className="border-b border-edge px-5 py-4 font-semibold">
        Planned spending
      </h2>
      <div className="space-y-3 px-5 py-4 text-sm">
        <p className="text-muted">
          Awaiting approval is planned, not held or spent. Planned totals include recorded spending,
          holds, and awaiting approval once.
        </p>
        {!tracking.complete ? (
          <p role="status" className="text-muted">
            Some current amounts are unavailable.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead>
              <tr>
                <th scope="col">USD</th>
                <th scope="col" className="text-right">
                  Today
                </th>
                <th scope="col" className="text-right">
                  This month
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [
                    'Recorded spending',
                    tracking.recordedDailyMicros,
                    tracking.recordedMonthlyMicros,
                  ],
                  ['Reserved or unresolved', tracking.totalHeldMicros, tracking.totalHeldMicros],
                  [
                    'Awaiting approval · planned',
                    tracking.pendingApprovalMicros,
                    tracking.pendingApprovalMicros,
                  ],
                  [
                    'Planned total',
                    tracking.dailyPlannedExposureMicros,
                    tracking.monthlyPlannedExposureMicros,
                  ],
                ] as const
              ).map(([label, daily, monthly]) => (
                <tr key={label} className="border-t border-edge">
                  <th scope="row" className="py-3 pr-3 font-normal">
                    {label}
                  </th>
                  <td className="px-2 py-3 text-right">{amount(daily)}</td>
                  <td className="py-3 pl-2 text-right">{amount(monthly)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="border-t border-edge px-5 py-4">
        <h3 className="text-sm font-semibold">Spending requests</h3>
        {requests === null ? (
          <p className="mt-2 text-sm text-muted" role="status">
            The request list is unavailable.
          </p>
        ) : requests.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No spending requests are waiting.</p>
        ) : (
          <ul className="mt-2 divide-y divide-edge">
            {requests.map((request) => (
              <li key={request.operationId} className="text-sm">
                <Link
                  className="flex min-h-11 flex-col justify-center py-3 [overflow-wrap:anywhere]"
                  href={spendingRequestHref(request.operationId)}
                >
                  <span className="font-medium text-accent hover:underline">
                    {request.quote?.requestText || 'Estimate unavailable'}
                  </span>
                  <span className="mt-1 text-muted">
                    {requestStatus(request.status)} · Request {request.operationId.slice(-8)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
