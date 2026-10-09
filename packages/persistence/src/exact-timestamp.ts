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
