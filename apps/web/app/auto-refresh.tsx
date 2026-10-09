'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Periodically refresh the current RSC route so dashboards (approvals, activity)
 * pick up new state without a manual reload. Pauses when the tab is hidden or a
 * form is mid-submit, so it never clobbers an in-flight action or burns cycles
 * in the background. Mount once per page.
 *
 * The cadence backs off while nothing is happening. `router.refresh()` re-runs
 * the whole route on the server — this page's queries AND the root layout's —
 * so a tab left open on Activity was re-querying the database every twelve
 * seconds all day to render the same screen. Backing off costs nothing when
 * work IS arriving (the first change resets it) and turns an idle tab from a
 * standing load into an occasional one.
 */
const MAX_INTERVAL_MS = 120_000;

export function AutoRefresh({
  intervalMs = 12_000,
  maxIntervalMs = MAX_INTERVAL_MS,
  refreshWhileEditing = false,
}: {
  intervalMs?: number;
  maxIntervalMs?: number;
  refreshWhileEditing?: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    let timer = 0;
    let wait = intervalMs;
    // What the page looked like last tick. The RSC payload is server-rendered,
    // so the rendered DOM is the only thing this side can compare — and it is
    // the right thing to compare, because it IS what a refresh would change.
    let previous = document.querySelector('main')?.textContent ?? '';

    const tick = () => {
      // Don't refresh while the owner is filling in or submitting a form.
      const busy =
        document.visibilityState !== 'visible' ||
        (!refreshWhileEditing &&
          (document.querySelector('form [aria-busy="true"]') !== null ||
            document.activeElement?.tagName === 'INPUT' ||
            document.activeElement?.tagName === 'TEXTAREA'));
      if (!busy) {
        const current = document.querySelector('main')?.textContent ?? '';
        // Measured before the refresh, so it reflects what the LAST one did.
        wait =
          current === previous
            ? Math.min(wait * 2, Math.max(intervalMs, maxIntervalMs))
            : intervalMs;
        previous = current;
        router.refresh();
      }
      timer = window.setTimeout(tick, wait);
    };

    timer = window.setTimeout(tick, wait);
    // Coming back to the tab should feel current immediately, and it is also
    // the moment something most likely did change — so the cadence resets.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      wait = intervalMs;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, 0);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, intervalMs, maxIntervalMs, refreshWhileEditing]);
  return null;
}
