import { usdDecimalToMicros } from './money.js';

/** Exact decimal task caps that fit the shared numeric(8,4) storage contract. */
export function normalizeTaskBudget(value: unknown, minimum = 0): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < minimum || amount > 9999.9999) return null;
  return amount.toFixed(4);
}

/** Decode a persisted task cap using its narrower numeric(8,4) contract. */
export function storedTaskBudgetToMicros(value: unknown): number {
  const normalized = normalizeTaskBudget(value);
  if (normalized === null) throw new Error('Task budget exceeds numeric(8,4) storage range');
  return usdDecimalToMicros(normalized);
}
