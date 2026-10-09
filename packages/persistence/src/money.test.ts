import { describe, expect, it } from 'vitest';
import {
  addLedgerMicros,
  addMicros,
  ledgerUsdToMicros,
  microsToUsd,
  storedLedgerUsdToMicros,
  storedUsdToMicros,
  usdDecimalToMicros,
  usdToMicros,
} from './money.js';
import { storedTaskBudgetToMicros } from './task-budget.js';

describe('ledger precision', () => {
  it('avoids floating point accumulation in budget decisions', () => {
    expect(microsToUsd(addMicros(usdToMicros(0.1), usdToMicros(0.2)))).toBe(0.3);
    expect(usdToMicros(0.000001)).toBe(1);
  });
  it('rejects invalid amounts and overflow rather than weakening the cap', () => {
    for (const value of [NaN, Infinity, -1, Number.MAX_VALUE])
      expect(() => usdToMicros(value)).toThrow();
    expect(() => addMicros(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
  it('keeps safe-micro arithmetic distinct from shared SQL storage bounds', () => {
    expect(ledgerUsdToMicros(0.0000005)).toBe(1);
    expect(ledgerUsdToMicros(9_999.999999)).toBe(9_999_999_999);
    expect(ledgerUsdToMicros(9_999.9999994)).toBe(9_999_999_999);
    expect(storedLedgerUsdToMicros('9999.999999')).toBe(9_999_999_999);
    expect(() => ledgerUsdToMicros(9_999.9999996)).toThrow('numeric(10,6)');
    expect(() => ledgerUsdToMicros(10_000)).toThrow('numeric(10,6)');
    expect(() => storedLedgerUsdToMicros('10000.000000')).toThrow('numeric(10,6)');
    expect(storedTaskBudgetToMicros('9999.9999')).toBe(9_999_999_900);
    expect(() => storedTaskBudgetToMicros('10000.0000')).toThrow('numeric(8,4)');
    expect(() => storedTaskBudgetToMicros('1.00001')).toThrow('numeric(8,4)');
    expect(addLedgerMicros(9_999_999_998, 1)).toBe(9_999_999_999);
    expect(() => addLedgerMicros(9_999_999_999, 1)).toThrow('numeric(10,6)');
  });

  it('validates persisted decimal syntax and exact boundary amounts without float coercion', () => {
    expect(usdDecimalToMicros('0.000001')).toBe(1);
    expect(usdDecimalToMicros('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [
      '9007199254.740992',
      '0.0000001',
      '0x10',
      '1e2',
      ' 2 ',
      '-0',
      '+1',
      '',
      '.1',
      '00.1',
    ])
      expect(() => usdDecimalToMicros(value)).toThrow();
    for (const value of [null, undefined, true, {}, []])
      expect(() => storedUsdToMicros(value)).toThrow();
    expect(storedUsdToMicros('0.300000')).toBe(300000);
    expect(storedUsdToMicros(0.3)).toBe(300000);
    expect(storedUsdToMicros(0.1 + 0.2)).toBe(300000);
    expect(() => storedUsdToMicros(0.0000001)).toThrow();
    expect(() => usdDecimalToMicros('1'.repeat(10000))).toThrow();
  });
});
