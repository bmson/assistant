/** The ledger stores USD at six decimal places on both databases. */
export function usdDecimalToMicros(value: string): number {
  if (value.length > 24 || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))
    throw new Error('USD must be a nonnegative decimal with at most six places');
  const [whole = '0', fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('USD exceeds the supported ledger precision');
  return Number(amount);
}

/** Stored decimals never pass through permissive Number/string coercion. */
export function storedUsdToMicros(value: unknown): number {
  if (typeof value === 'string') return usdDecimalToMicros(value);
  if (typeof value === 'number') {
    const micros = usdToMicros(value);
    if (Math.abs(microsToUsd(micros) - value) > Number.EPSILON * Math.max(1, value))
      throw new Error('Stored USD exceeds ledger precision');
    return micros;
  }
  throw new Error('Invalid stored USD amount');
}

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('USD must be finite and nonnegative');
  const micros = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error('USD exceeds the supported ledger precision');
  return micros;
}

export function microsToUsd(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error('Microdollars must be a nonnegative safe integer');
  }
  return micros / 1_000_000;
}

/** Keep arithmetic exact: an overflow must never turn into an accepted budget. */
export function addMicros(...amounts: number[]): number {
  let total = 0;
  for (const amount of amounts) {
    microsToUsd(amount);
    total += amount;
    if (!Number.isSafeInteger(total)) throw new Error('Ledger total exceeds safe precision');
  }
  return total;
}

/** Maximum row amount represented by PostgreSQL numeric(10,6). */
export const MAX_LEDGER_USD_MICROS = 9_999_999_999;

/** Validate after the six-place rounding shared by both persistence adapters. */
export function ledgerUsdToMicros(usd: number): number {
  return assertLedgerMicros(usdToMicros(usd));
}

/** Decode a persisted per-row amount and enforce numeric(10,6) range. */
export function storedLedgerUsdToMicros(value: unknown): number {
  return assertLedgerMicros(storedUsdToMicros(value));
}

/** Validate a per-row numeric(10,6) amount or aggregate task spend. */
export function assertLedgerMicros(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0 || micros > MAX_LEDGER_USD_MICROS)
    throw new Error('USD exceeds the shared numeric(10,6) storage range');
  return micros;
}

export function addLedgerMicros(...amounts: number[]): number {
  return assertLedgerMicros(addMicros(...amounts));
}
