/** Validate a UTC checkpoint without discarding its database precision. */
export function parseExactTimestamp(value: string): {
  seconds: number;
  nanoseconds: number;
  exact: string;
} {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,9})Z$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error('Invalid conversation watermark');
  const milliseconds = Date.parse(`${match[1]}.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  )
    throw new Error('Invalid conversation watermark');
  return {
    seconds: milliseconds / 1000,
    nanoseconds: Number(match[2].padEnd(9, '0')),
    exact: value,
  };
}

/** A Date-compatible instant whose ordering retains storage nanoseconds. */
export class ExactTimestamp extends Date {
  constructor(
    readonly seconds: bigint,
    readonly nanoseconds: number,
  ) {
    super(Number(seconds * 1000n + BigInt(Math.floor(nanoseconds / 1_000_000))));
    if (
      !Number.isInteger(nanoseconds) ||
      nanoseconds < 0 ||
      nanoseconds >= 1_000_000_000 ||
      !Number.isFinite(this.getTime())
    )
      throw new Error('Invalid exact timestamp');
    // Seal only exact metadata; subclasses still add their own storage encoding fields.
    Object.defineProperties(this, {
      seconds: { value: seconds, enumerable: true, writable: false, configurable: false },
      nanoseconds: { value: nanoseconds, enumerable: true, writable: false, configurable: false },
    });
  }
}

/** Reject invalid dates and precise dates mutated independently of their exact fields. */
export function isValidExactTimestamp(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    (!(value instanceof ExactTimestamp) ||
      (typeof value.seconds === 'bigint' &&
        Number.isInteger(value.nanoseconds) &&
        value.nanoseconds >= 0 &&
        value.nanoseconds < 1_000_000_000 &&
        value.getTime() ===
          Number(value.seconds * 1000n + BigInt(Math.floor(value.nanoseconds / 1_000_000)))))
  );
}

/** Ordinary dates represent exact milliseconds; precise dates retain their remainder. */
export function compareExactTimestamps(left: Date, right: Date): number {
  const instant = (value: Date): bigint => {
    if (!isValidExactTimestamp(value)) throw new Error('Invalid exact timestamp');
    return value instanceof ExactTimestamp
      ? value.seconds * 1_000_000_000n + BigInt(value.nanoseconds)
      : BigInt(value.getTime()) * 1_000_000n;
  };
  const a = instant(left);
  const b = instant(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Offset a repository instant without dropping its sub-millisecond remainder. */
export function offsetExactTimestamp(value: Date, milliseconds: number): ExactTimestamp {
  if (!isValidExactTimestamp(value) || !Number.isSafeInteger(milliseconds))
    throw new Error('Invalid exact timestamp offset');
  const total =
    (value instanceof ExactTimestamp
      ? value.seconds * 1_000_000_000n + BigInt(value.nanoseconds)
      : BigInt(value.getTime()) * 1_000_000n) +
    BigInt(milliseconds) * 1_000_000n;
  const remainder = ((total % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  return new ExactTimestamp((total - remainder) / 1_000_000_000n, Number(remainder));
}
