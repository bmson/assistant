'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { formatFriendlyDateTime } from '@/lib/format';
import { btn, cardShellClass, cardTitleClass, focusRing } from '@/lib/ui';
import { SecurityReviewSession } from './security-notice-review-session';

function readableCategory(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function SecurityNoticeReview({ ownerId }: { ownerId: string }) {
  const session = useMemo(() => new SecurityReviewSession(ownerId), [ownerId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { items, loadState, refreshing, pendingId, message, staleList } = state;

  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);

  return (
    <section aria-labelledby="security-reviews-title" className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="security-reviews-title" className="text-lg font-semibold text-strong">
            Security reviews
          </h2>
          <p className="mt-1 text-sm text-muted">Up to 50 notices that may need your review.</p>
        </div>
        <button
          type="button"
          className={btn.outline}
          onClick={() => void session.refresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {message ? (
        <p className="mb-3 text-sm text-muted" role="status">
          {message}
        </p>
      ) : null}
      {staleList ? (
        <p className="mb-3 text-xs text-muted">Displayed reviews may be out of date.</p>
      ) : null}
      {loadState === 'loading' ? (
        <p className="text-sm text-muted" role="status">
          Loading security reviews…
        </p>
      ) : null}
      {loadState === 'unavailable' ? (
        <div className={`${cardShellClass} p-4 text-sm text-muted`} role="status">
          Security reviews are unavailable right now. Use Refresh to try again.
        </div>
      ) : null}
      {loadState === 'ready' && items.length === 0 && !staleList ? (
        <div className={`${cardShellClass} p-4 text-sm text-muted`} role="status">
          No security reviews need attention.
        </div>
      ) : null}
      {loadState === 'ready' && items.length === 0 && staleList ? (
        <p className="text-sm text-muted" role="status">
          No current list is available. Refresh to check for security reviews.
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className={`${cardShellClass} divide-y divide-edge/70`}>
          {items.map((item) => (
            <article key={item.incidentId} className="grid min-w-0 gap-3 p-4 sm:p-5">
              <div className="min-w-0">
                <h3 className={`${cardTitleClass} [overflow-wrap:anywhere]`}>
                  {item.subject || 'Security activity'}
                </h3>
                <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
                  {item.fromName ? `${item.fromName} · ` : ''}
                  {readableCategory(item.category)}
                </p>
                <time dateTime={item.observedAt} className="mt-1 block text-xs text-muted">
                  {formatFriendlyDateTime(new Date(item.observedAt))}
                </time>
                {item.materialChangeReason ? (
                  <p className="mt-2 text-sm text-muted">{item.materialChangeReason}</p>
                ) : null}
                <details className="mt-2">
                  <summary
                    className={`cursor-pointer text-sm font-medium text-accent ${focusRing}`}
                  >
                    Review notice details
                  </summary>
                  <div className="mt-2 grid gap-1 text-sm leading-6 text-muted [overflow-wrap:anywhere]">
                    <p>As described in the notice:</p>
                    {item.evidence?.evidenceQuote ? <p>{item.evidence.evidenceQuote}</p> : null}
                    {item.evidence?.eventType ? <p>{item.evidence.eventType}</p> : null}
                    {!item.evidence?.evidenceQuote && !item.evidence?.eventType ? (
                      <p>No additional notice detail is available.</p>
                    ) : null}
                  </div>
                </details>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btn.outline}
                  disabled={pendingId !== null}
                  onClick={() => void session.decide(item, 'expected')}
                >
                  {pendingId === item.incidentId ? 'Saving…' : 'Mark expected'}
                </button>
                <button
                  type="button"
                  className={btn.outline}
                  disabled={pendingId !== null}
                  onClick={() => void session.decide(item, 'dismissed')}
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
