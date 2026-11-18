import type { EstimatedCostOverviewResponse } from '@assistant/persistence';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PendingSpendingOverview, spendingRequestHref } from './pending-spending-overview';

function overview(): EstimatedCostOverviewResponse {
  return {
    ok: true,
    requests: [
      {
        status: 'pending',
        operationId: 'request/a',
        quote: { operationId: 'request/a', taskId: 'task-a', requestText: 'Request A' },
      },
      {
        status: 'expired_or_needs_refresh',
        operationId: 'request-b',
        quote: { operationId: 'request-b', taskId: 'task-b', requestText: 'Request B' },
      },
    ],
    tracking: {
      observedAt: '2029-01-01T00:00:00Z',
      complete: true,
      recordedDailyMicros: 100_000,
      recordedMonthlyMicros: 200_000,
      totalHeldMicros: 300_000,
      historicalUnknownMicros: 0,
      pendingApprovalMicros: 400_000,
      dailyPlannedExposureMicros: 800_000,
      monthlyPlannedExposureMicros: 900_000,
    },
  } as EstimatedCostOverviewResponse;
}

describe('pending spending overview', () => {
  it('shows pending and planned totals separately and links exact requests, including expired ones', () => {
    const html = renderToStaticMarkup(<PendingSpendingOverview overview={overview()} />);
    expect(html).toContain('Awaiting approval');
    expect(html).toContain('$0.40');
    expect(html).toContain('$0.80');
    expect(html).toContain('$0.90');
    expect(html).toContain('not held or spent');
    expect(html).toContain('/costs/requests/request%2Fa');
    expect(html).toContain('Estimate needs refreshing');
    expect(html).toContain(`Request ${'request/a'.slice(-8)}`);
    expect(html).toContain(`Request ${'request-b'.slice(-8)}`);
    expect(spendingRequestHref('request/a')).toBe('/costs/requests/request%2Fa');
  });
  it('keeps unknown totals and an incomplete inventory distinct from zero and an empty list', () => {
    const view = overview();
    if (!view.ok) throw new Error('fixture');
    const html = renderToStaticMarkup(
      <PendingSpendingOverview
        overview={{
          ...view,
          requests: null,
          tracking: {
            ...view.tracking,
            complete: false,
            pendingApprovalMicros: null,
            dailyPlannedExposureMicros: null,
            monthlyPlannedExposureMicros: null,
          },
        }}
      />,
    );
    expect(html).toContain('Some current amounts are unavailable');
    expect(html).toContain('The request list is unavailable');
    expect(html).not.toContain('No spending requests are waiting');
    expect(html).not.toContain('$0.00');
  });
});
