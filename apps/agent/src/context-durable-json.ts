/** Match the expected side to the JSON wire shape used by durable receipts. */
export function normalizeExpectedDurableJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeExpectedDurableJson);
  if (!value || typeof value !== 'object') return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeExpectedDurableJson(child)]),
  );
}
