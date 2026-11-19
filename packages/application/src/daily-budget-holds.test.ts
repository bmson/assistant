import type { CostTotals } from '@assistant/persistence';
import { expect, it } from 'vitest';
import { classifyDailyBudgetHolds } from './costs.js';

const totals = (dailyHeldUsd: number | undefined, dailyLimitUsd: number): CostTotals => ({
  dailySpentUsd: 0,
  monthlySpentUsd: 0,
  heldUsd: 45,
  dailyHeldUsd,
  dailyLimitUsd,
  monthlyLimitUsd: 50,
  softPct: 80,
});

it.each([
  [0, 4, 'within_limit'],
  [1, 4, 'within_limit'],
  [1.000001, 4, 'above_threshold'],
  [0, 0, 'paused'],
  [1, 0, 'above_threshold'],
  [2, Infinity, 'uncapped'],
  [undefined, 4, 'unavailable'],
  [NaN, 4, 'unavailable'],
  [-1, 4, 'unavailable'],
  [1, -1, 'unavailable'],
] as const)('compares today’s holds %s with today’s cap %s', (held, cap, expected) => {
  expect(classifyDailyBudgetHolds(totals(held, cap))).toBe(expected);
});
