import type { CostRepository, MaintenanceRepository } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { emitBudgetNotices } from './cost.js';

it('describes a pause using only the recorded spend and holds for the affected period', async () => {
  const ledger = {
    kind: 'cost-repository',
    totals: async () => ({
      dailySpentUsd: 1.25,
      dailyHeldUsd: 2.75,
      dailyLimitUsd: 4,
      monthlySpentUsd: 8,
      monthlyHeldUsd: 3,
      monthlyLimitUsd: 30,
      heldUsd: 120,
      softPct: 80,
    }),
  } as CostRepository;
  const postBudgetNotice = vi.fn(async () => true);
  const maintenance = { postBudgetNotice } as unknown as MaintenanceRepository;
  expect(await emitBudgetNotices({ costs: ledger, maintenance }, 'owner')).toEqual([
    expect.stringMatching(/^budget-notice:daily:100:/),
  ]);
  expect(postBudgetNotice).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      pct: 100,
      text: 'Budget: non-critical work may pause. $1.25 recorded as spend and $2.75 held against the $4.00 daily limit. Review or raise the limit in [Costs](/costs).',
    }),
  );
});
