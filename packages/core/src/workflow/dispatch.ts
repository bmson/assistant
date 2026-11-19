import type { DispatchOutbox, TaskQueue } from '@assistant/persistence';

/** Durable dispatch: bounded work, fenced settlement, and no provider call in a transaction. */
export async function dispatchOutbox(
  outbox: DispatchOutbox,
  queue: TaskQueue,
  options: {
    batch?: number;
    concurrency?: number;
    maxDurationMs?: number;
    ids?: readonly string[];
  } = {},
) {
  const { batch = 50, concurrency = 4, maxDurationMs = 30_000 } = options;
  if (
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 200 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 45_000
  )
    throw new Error('Invalid dispatch bounds');
  const deadline = Date.now() + maxDurationMs;
  const signal = AbortSignal.timeout(maxDurationMs);
  const ids = options.ids ? options.ids.slice(0, batch) : await outbox.due(batch);
  const result = { delivered: 0, retried: 0, leaseLost: 0, errors: 0 };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < ids.length && Date.now() < deadline) {
        const id = ids[cursor++];
        if (!id) continue;
        try {
          const lease = await outbox.claim(id);
          if (!lease) continue;
          try {
            signal.throwIfAborted();
            await queue.enqueue(lease.taskId, lease.generation, signal);
            if (await outbox.acknowledge(lease)) result.delivered++;
            else result.leaseLost++;
          } catch {
            // Even an ambiguous response retries with the SAME provider task name.
            if (await outbox.retry(lease)) result.retried++;
            else result.leaseLost++;
          }
        } catch {
          // A failed settlement stays recoverable after its durable lease expires.
          result.errors++;
        }
      }
    }),
  );
  return result;
}
