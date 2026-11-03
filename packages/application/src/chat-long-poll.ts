import { getChatUpdates, SETTLED_TASK_STATUSES, watchAuthorizedChatChanges } from './chat.js';

/**
 * Taken from the read this wraps rather than imported from the database
 * package: holding a poll open is a timing concern with no SQL of its own, and
 * this package is being moved off direct database SDK imports.
 */
type ChatDb = Parameters<typeof getChatUpdates>[0];

export type ChatUpdates = NonNullable<Awaited<ReturnType<typeof getChatUpdates>>>;

/**
 * The longest a caller may ask us to hold its poll open.
 *
 * Comfortably inside Cloud Run's request window and inside the default
 * idle timeouts of the proxies in front of it, so a held poll ends because we
 * ended it, not because something in the middle gave up on the connection.
 */
export const MAX_CHAT_WAIT_MS = 25_000;

/**
 * How often a held poll re-reads while it waits.
 *
 * This is the server's own loop — the client spends one request on it rather
 * than one per interval — but the reads are not free, and moving the loop
 * server-side moved the load with it. Each re-read is a handful of queries,
 * so the interval is what decides how much standing database work an open
 * thread costs.
 *
 * The idle figure is deliberately conservative. It replaces a client poll that
 * ran every 12s, so 2s would have been six times the reads for a thread where
 * nothing is happening — and every open tab pays it, for as long as it is
 * open. At 5s an assistant-initiated message still surfaces in less than half
 * the time it used to, for roughly a third of the queries 2s would have cost.
 *
 * A thread with a live task is the opposite case: something is about to land
 * that a person is watching for, and the window is seconds rather than hours,
 * so it is worth checking often for as long as it lasts.
 */
const ACTIVE_RECHECK_MS = 500;
const IDLE_RECHECK_MS = 5_000;
const MAX_CHAT_CHANGE_HINT_CALLBACKS = 64;
const MAX_CHAT_CHANGE_HINT_READS = 4;

function activityFingerprint(activity: ChatUpdates['activity']): string {
  return activity.map((entry) => `${entry.step}:${entry.toolName}:${entry.status}`).join('|');
}

/**
 * Is this worth waking the client for?
 *
 * `refreshed` is deliberately excluded: those rows come back on every tick by
 * design (the caller asked us to re-read cards it is already showing), so
 * counting them as news would end every hold instantly and turn a long poll
 * back into a fast one.
 */
function hasChatNews(updates: ChatUpdates, baselineActivity: string | undefined): boolean {
  if (updates.messages.length > 0 || updates.superseded.length > 0) return true;
  // A backlog: the client loops immediately on this rather than waiting.
  if (updates.hasMore) return true;
  if (updates.taskStatus && SETTLED_TASK_STATUSES.has(updates.taskStatus)) return true;
  // Tool progress drives the "what is it doing" indicator. Only movement
  // during this hold counts — whatever was already running was in the response
  // that sent the client back here.
  return (
    baselineActivity !== undefined && activityFingerprint(updates.activity) !== baselineActivity
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function watchLifetime(
  requestSignal: AbortSignal | undefined,
  durationMs: number,
  onStop: () => void,
) {
  const controller = new AbortController();
  let reason: 'abort' | 'deadline' | undefined;
  let resolveStopped!: (value: 'abort' | 'deadline') => void;
  const stopped = new Promise<'abort' | 'deadline'>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = (value: 'abort' | 'deadline') => {
    if (reason) return;
    reason = value;
    controller.abort();
    onStop();
    resolveStopped(value);
  };
  const onAbort = () => stop('abort');
  requestSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('deadline'), durationMs);
  if (requestSignal?.aborted) stop('abort');
  return {
    signal: controller.signal,
    stopped,
    get reason() {
      return reason;
    },
    cleanup() {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onAbort);
      if (!reason) controller.abort();
    },
  };
}

/**
 * `getChatUpdates`, but willing to wait for an answer.
 *
 * Without this every client has to guess an interval, and pays for the guess
 * twice: a reply that is ready sits unseen until the next tick, and every tick
 * that finds nothing still costs a request. That is worst on a phone, where
 * each tick is a radio wake-up, which is why the mobile client's intervals had
 * to be tuned against battery rather than against how fast a person wants
 * their answer.
 *
 * Holding the connection instead lets the server answer the moment there is
 * something to say. `waitMs` of 0 (or absent) preserves the old
 * return-immediately behaviour exactly, so a caller that has not been updated
 * is unaffected.
 */
export async function waitForChatUpdates(
  db: ChatDb,
  input: Parameters<typeof getChatUpdates>[1] & { waitMs?: number; signal?: AbortSignal },
): Promise<ChatUpdates | null> {
  const budget = Math.min(Math.max(input.waitMs ?? 0, 0), MAX_CHAT_WAIT_MS);
  const deadline = Date.now() + budget;
  const recheckMs = input.taskId ? ACTIVE_RECHECK_MS : IDLE_RECHECK_MS;
  let baselineActivity: string | undefined;
  let canonicalReadInFlight = false;
  // If a deadline wins a race, persistence may keep its read running. Track
  // that underlying promise so we never start an overlapping canonical read.
  const readCanonical = async () => {
    canonicalReadInFlight = true;
    try {
      return await getChatUpdates(db, input);
    } finally {
      canonicalReadInFlight = false;
    }
  };
  let updates = await readCanonical();
  if (!updates || hasChatNews(updates, baselineActivity)) return updates;
  baselineActivity = activityFingerprint(updates.activity);
  if (budget <= 0 || input.signal?.aborted) return updates;

  let watcher: { close(): void } | null = null;
  let watcherFailed = false;
  let watcherActive = false;
  let pendingHint = false;
  let hintCallbackCount = 0;
  let hintReadCount = 0;
  let firstHintReadUsed = false;
  let lastReadAt = Date.now();
  let wakeWaiter: (() => void) | undefined;
  let resolveWatcherFailure!: () => void;
  const watcherFailure = new Promise<void>((resolve) => {
    resolveWatcherFailure = resolve;
  });
  let lifetime: ReturnType<typeof watchLifetime> | undefined;
  const closeWatcher = () => {
    watcherActive = false;
    if (!watcher) return;
    const closing = watcher;
    watcher = null;
    try {
      closing.close();
    } catch {
      // Closing a read hint is best-effort; canonical polling remains valid.
    }
  };
  const disableWatcher = () => {
    closeWatcher();
    lifetime?.cleanup();
    lifetime = undefined;
  };
  const wake = () => wakeWaiter?.();
  const failWatcher = () => {
    if (watcherFailed) return;
    watcherFailed = true;
    closeWatcher();
    resolveWatcherFailure();
    wake();
  };
  const onChange = () => {
    if (!watcherActive || watcherFailed) return;
    hintCallbackCount += 1;
    if (hintCallbackCount > MAX_CHAT_CHANGE_HINT_CALLBACKS) {
      failWatcher();
      return;
    }
    pendingHint = true;
    if (!firstHintReadUsed || Date.now() - lastReadAt >= ACTIVE_RECHECK_MS) wake();
  };
  const onError = (_error: unknown) => {
    if (!watcherActive) return;
    failWatcher();
  };

  try {
    if (input.taskId && !input.signal?.aborted) {
      const lifetimeMs = deadline - Date.now();
      if (lifetimeMs <= 0) return updates;
      watcherActive = true;
      lifetime = watchLifetime(input.signal, lifetimeMs, () => {
        closeWatcher();
        wake();
      });
      const setup = watchAuthorizedChatChanges(db, {
        conversationId: input.conversationId,
        taskId: input.taskId,
        signal: lifetime.signal,
        onChange,
        onError,
      }).then(
        (handle) => ({ kind: 'ready' as const, handle }),
        () => ({ kind: 'failed' as const }),
      );
      const setupOutcome = await Promise.race([
        setup,
        lifetime.stopped.then(() => ({ kind: 'stopped' as const })),
        watcherFailure.then(() => ({ kind: 'watch-failed' as const })),
      ]);
      if (setupOutcome.kind === 'stopped') {
        void setup.then((late) => {
          if (late.kind === 'ready') {
            try {
              late.handle?.close();
            } catch {
              // The watch already exceeded its owner request lifetime.
            }
          }
        });
        if (lifetime.reason === 'deadline' && !canonicalReadInFlight) return await readCanonical();
        return updates;
      }
      if (setupOutcome.kind === 'watch-failed') {
        void setup.then((late) => {
          if (late.kind === 'ready') {
            try {
              late.handle?.close();
            } catch {
              // A failed setup is handled by the existing canonical poll.
            }
          }
        });
        watcherActive = false;
        lifetime.cleanup();
        lifetime = undefined;
      } else if (setupOutcome.kind === 'failed' || !setupOutcome.handle) {
        watcherActive = false;
        lifetime.cleanup();
        lifetime = undefined;
      } else {
        watcher = setupOutcome.handle;
        if (lifetime.reason || watcherFailed) {
          disableWatcher();
          lifetime = undefined;
        }
      }
      const activeLifetime = lifetime;
      if (watcher && watcherActive && !watcherFailed && activeLifetime) {
        // Subscribe before re-reading. This canonical read closes the gap
        // between the initial authorization/read and listener registration.
        pendingHint = false;
        const afterSubscribeOutcome = await Promise.race([
          readCanonical().then((value) => ({ kind: 'read' as const, value })),
          activeLifetime.stopped.then(() => ({ kind: 'stopped' as const })),
        ]);
        if (afterSubscribeOutcome.kind === 'stopped') return updates;
        const afterSubscribe = afterSubscribeOutcome.value;
        if (!afterSubscribe || hasChatNews(afterSubscribe, baselineActivity)) return afterSubscribe;
        updates = afterSubscribe;
        baselineActivity = activityFingerprint(updates.activity);
        lastReadAt = Date.now();
      } else if (watcher) {
        closeWatcher();
      }
    }

    while (true) {
      const remaining = deadline - Date.now();
      if (input.signal?.aborted) return updates;
      if (remaining <= 0) {
        if (lifetime?.reason === 'deadline' && !canonicalReadInFlight) return await readCanonical();
        return updates;
      }
      if (watcherFailed && !watcher && lifetime) {
        lifetime.cleanup();
        lifetime = undefined;
      }

      if (watcherActive && watcher) {
        const now = Date.now();
        const hintMayRead =
          pendingHint && (!firstHintReadUsed || now - lastReadAt >= ACTIVE_RECHECK_MS);
        if (hintMayRead) {
          if (hintReadCount >= MAX_CHAT_CHANGE_HINT_READS) {
            watcherFailed = true;
            disableWatcher();
            continue;
          }
          pendingHint = false;
          firstHintReadUsed = true;
          hintReadCount += 1;
          const readOutcome = lifetime
            ? await Promise.race([
                readCanonical().then((value) => ({ kind: 'read' as const, value })),
                lifetime.stopped.then(() => ({ kind: 'stopped' as const })),
              ])
            : { kind: 'stopped' as const };
          if (readOutcome.kind === 'stopped') return updates;
          updates = readOutcome.value;
          if (!updates || hasChatNews(updates, baselineActivity)) return updates;
          baselineActivity = activityFingerprint(updates.activity);
          lastReadAt = Date.now();
          continue;
        }

        const hintCooldown = pendingHint
          ? Math.max(0, ACTIVE_RECHECK_MS - (now - lastReadAt))
          : ACTIVE_RECHECK_MS;
        const waitMs = Math.min(remaining, hintCooldown);
        const wakeReason = await new Promise<'change' | 'timeout' | 'abort'>((resolve) => {
          let settled = false;
          const finish = (reason: 'change' | 'timeout' | 'abort') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', onAbort);
            if (wakeWaiter === onWake) wakeWaiter = undefined;
            resolve(reason);
          };
          const onAbort = () => finish('abort');
          const onWake = () => finish('change');
          const timer = setTimeout(() => finish('timeout'), waitMs);
          wakeWaiter = onWake;
          input.signal?.addEventListener('abort', onAbort, { once: true });
          if (watcherFailed) finish('change');
          else if (input.signal?.aborted) finish('abort');
        });
        if (wakeReason === 'abort' || input.signal?.aborted) return updates;
        if (watcherFailed) {
          disableWatcher();
          continue;
        }

        // Timeout is the unchanged 500ms active fallback. If a hint was
        // coalesced during the cooldown, this read consumes it too.
        if (wakeReason === 'timeout') {
          if (pendingHint) {
            if (hintReadCount >= MAX_CHAT_CHANGE_HINT_READS) {
              watcherFailed = true;
              disableWatcher();
              continue;
            }
            pendingHint = false;
            firstHintReadUsed = true;
            hintReadCount += 1;
          }
          const readOutcome = lifetime
            ? await Promise.race([
                readCanonical().then((value) => ({ kind: 'read' as const, value })),
                lifetime.stopped.then(() => ({ kind: 'stopped' as const })),
              ])
            : { kind: 'stopped' as const };
          if (readOutcome.kind === 'stopped') return updates;
          updates = readOutcome.value;
          if (!updates || hasChatNews(updates, baselineActivity)) return updates;
          baselineActivity = activityFingerprint(updates.activity);
          lastReadAt = Date.now();
        }
        continue;
      }

      await sleep(Math.min(recheckMs, remaining), input.signal);
      if (input.signal?.aborted) return updates;
      updates = await readCanonical();
      if (!updates || hasChatNews(updates, baselineActivity)) return updates;
      baselineActivity = activityFingerprint(updates.activity);
    }
  } finally {
    closeWatcher();
    lifetime?.cleanup();
  }
}
