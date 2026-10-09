'use client';

import { Archive } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { type CardRefreshAttempt, cardIsRefreshing } from '@/app/chat/[id]/generated-card-state';
import { ResponseCards } from '@/app/chat/[id]/response-card';
import { btnSm } from '@/lib/ui';
import { dismissCard, refreshSavedCardInline } from './actions';

type Card = Record<string, unknown> & { id: string; revisionId: string };

/** Refresh server snapshots while saved objects change, without adding chat turns. */
export function SavedCardGrid({ cards, timeZone }: { cards: Card[]; timeZone: string }) {
  const router = useRouter();
  const [attempts, setAttempts] = useState<Record<string, CardRefreshAttempt>>({});
  const [paused, setPaused] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const active = cards.some((card) => cardIsRefreshing(card, attempts[card.id] ?? null));
  // biome-ignore lint/correctness/useExhaustiveDependencies: Check again deliberately restarts the bounded polling window.
  useEffect(() => {
    if (!active) return;
    const deadline = Date.now() + 5 * 60_000;
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) {
        window.clearInterval(timer);
        setPaused(true);
      } else if (document.visibilityState === 'visible') {
        router.refresh();
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, router, pollGeneration]);

  return (
    <div className="mt-8 grid gap-5">
      {paused && active ? (
        <p role="status" className="text-sm text-muted">
          This update is taking longer than expected.{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              setPaused(false);
              setPollGeneration((value) => value + 1);
              router.refresh();
            }}
          >
            Check again
          </button>
        </p>
      ) : null}
      {cards.map((card) => (
        <article key={card.id} className="min-w-0">
          <ResponseCards
            cards={[card]}
            timeZone={timeZone}
            onRefresh={async (id, revisionId, operationId) => {
              const result = await refreshSavedCardInline(id, revisionId, operationId);
              if (result.ok) {
                setAttempts((current) => ({
                  ...current,
                  [id]: { revision: revisionId, taskId: result.taskId, state: 'refreshing' },
                }));
                setPaused(false);
                setPollGeneration((value) => value + 1);
                router.refresh();
              }
              return result;
            }}
          />
          <form action={dismissCard} className="mt-2 flex justify-end px-1">
            <input type="hidden" name="cardId" value={card.id} />
            <button type="submit" className={btnSm.outline}>
              <Archive className="size-3" aria-hidden="true" />
              Dismiss
            </button>
          </form>
        </article>
      ))}
    </div>
  );
}
