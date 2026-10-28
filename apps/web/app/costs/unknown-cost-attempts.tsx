import type { UnknownCostAttemptSummary } from '@assistant/application/costs';
import { formatUsd } from '@/lib/format';

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
              Retained reservation estimate {formatUsd(summary.estimatedUsd)}. Estimate only, not
              confirmed spend. Do not add this estimate to spend totals.
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
