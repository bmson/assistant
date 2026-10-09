const inFlight = new Map<string, Promise<unknown>>();

/**
 * Share one computation between callers that ask for the same thing at the same
 * time. Nothing is remembered once it settles — the next caller computes afresh —
 * so settled results are not cached. Do not use this for refreshes that must
 * observe a mutation: a new caller could otherwise join an older in-flight read.
 *
 * The phone refreshes the overview on foreground, after a decision, when a page
 * opens and on pull-to-refresh, and those overlap. Each used to run its own copy
 * of a read that touches several collections.
 */
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = run().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}
