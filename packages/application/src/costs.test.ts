import { describe, expect, it } from 'vitest';
import { normalizeBudgetCaps } from './costs.js';

describe('normalizeBudgetCaps', () => {
  it('normalizes whole-cent USD strings and accepts zero as a hard stop', () => {
    expect(normalizeBudgetCaps({ daily: '3.5', task_default: '0' })).toEqual({
      caps: { daily: '3.50', task_default: '0.00' },
    });
  });

  it('leaves blank and omitted scopes unchanged when another cap is supplied', () => {
    expect(normalizeBudgetCaps({ daily: '', monthly: '20' })).toEqual({
      caps: { monthly: '20.00' },
    });
  });

  it.each(['12garbage', '0.001', '-1', '10000.01', '  ', '1e2'])(
    'rejects ambiguous or out-of-range input %s',
    (value) => {
      expect(normalizeBudgetCaps({ daily: value })).toHaveProperty('error');
    },
  );

  it('rejects numeric values and a request with no applied scopes', () => {
    expect(normalizeBudgetCaps({ daily: 2 as unknown as string })).toHaveProperty('error');
    expect(normalizeBudgetCaps({ daily: '', monthly: '' })).toHaveProperty('error');
    expect(normalizeBudgetCaps({})).toHaveProperty('error');
  });
});
