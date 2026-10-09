import { describe, expect, it } from 'vitest';
import { normalizeTaskBudget } from './task-budget.js';
import { newTaskRecord } from './task-creation.js';

describe('shared task cap precision', () => {
  it('accepts the exact representable maximum without rounding', () => {
    expect(normalizeTaskBudget(9999.9999, 0.01)).toBe('9999.9999');
    expect(
      newTaskRecord(
        {
          agentId: 'owner',
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          budgetUsdLimit: '9999.9999',
        },
        'task',
        new Date(),
      ).budgetUsdLimit,
    ).toBe('9999.9999');
  });
  it.each([9999.99995, 10000, Infinity, NaN, -1, '1e2', ' 1 ', '0x10', '9999.99999'])(
    'rejects %s instead of rounding to a storage overflow',
    (value) => {
      expect(normalizeTaskBudget(value, 0.01)).toBeNull();
      expect(() =>
        newTaskRecord(
          {
            agentId: 'owner',
            type: 'adhoc',
            trust: 'owner',
            trigger: {},
            budgetUsdLimit: String(value),
          },
          'task',
          new Date(),
        ),
      ).toThrow();
    },
  );
});
