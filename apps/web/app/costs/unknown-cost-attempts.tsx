import type { UnknownCostAttemptSummary } from '@assistant/application/costs';
import { formatUsdExposure } from '@/lib/format';

export function UnknownCostAttempts({ summary }: { summary: UnknownCostAttemptSummary }) {
  if (summary.count === 0 && summary.countComplete) return null;

  return (
    <div className="mt-4 rounded-xl bg-raised px-3 py-2 text-sm">
      {!summary.countComplete && summary.count === 0 ? (
        <p>Outstanding unknown outcome coverage unavailable.</p>
      ) : (
        <>
          <p className="font-medium">
            Outstanding unknown outcomes:{' '}
            {summary.countComplete ? summary.count : `at least ${summary.count}`}
          </p>
          {summary.estimateComplete && summary.estimatedUsd !== null ? (
            <p className="mt-1 text-muted">
              Retained reservation estimate {formatUsdExposure(summary.estimatedUsd)}. Estimate
              only, not confirmed spend. Do not add this estimate to spend totals.
            </p>
          ) : (
            <p className="mt-1 text-muted">
              Retained reservation estimate unavailable. Do not add an unknown estimate to spend
              totals.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function DispatchingCostAttempts({ summary }: { summary: UnknownCostAttemptSummary }) {
  if (summary.count === 0 && summary.countComplete) return null;

  return (
    <div className="mt-4 rounded-xl bg-raised px-3 py-2 text-sm">
      {!summary.countComplete && summary.count === 0 ? (
        <p>In-flight reservation coverage unavailable.</p>
      ) : (
        <>
          <p className="font-medium">
            In-flight reservations:{' '}
            {summary.countComplete ? summary.count : `at least ${summary.count}`}
          </p>
          {summary.estimateComplete && summary.estimatedUsd !== null ? (
            <p className="mt-1 text-muted">
              Retained reservation estimate {formatUsdExposure(summary.estimatedUsd)}. Estimate
              only, not confirmed spend. Included in budget holds above.
            </p>
          ) : (
            <p className="mt-1 text-muted">
              Retained reservation estimate unavailable. Included in budget holds above.
            </p>
          )}
        </>
      )}
    </div>
  );
}
