'use client';

import { ChevronDown, Lightbulb, Mail } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { decideSuggestionInline, snoozeSuggestionInline } from '@/app/suggestions/actions';
import { focusRing } from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';
import { DecisionActions, DecisionCard, DecisionReceipt, DecisionReceipts } from './decision-card';
import {
  SuggestionContextContent,
  suggestionContext,
  suggestionWakeLabel,
} from './suggestion-context';

import {
  acceptedSuggestionLabel,
  type SuggestionResolution,
  type SuggestionStatus,
  suggestionStatus,
} from './suggestion-state';

export type { SuggestionStatus } from './suggestion-state';

export interface InlineSuggestionPart {
  type: 'suggestion';
  suggestionId: string;
  summary: string;
  proposedAction: string;
  status?: SuggestionStatus;
  acceptedTaskId?: string;
  acceptedTaskStatus?: string;
  acceptedTaskSummary?: string;
  snoozedUntil?: string;
  actionLabel?: string;
  contextCard?: unknown;
}

/**
 * "I noticed X — want me to Y?" with a one-tap yes.
 *
 * Deliberately not an approval card. An approval says "this is about to
 * happen, stop it if you want"; this says "nothing is happening, shall it?".
 * Accepting does not perform the action — it creates the work, which then runs
 * the normal pipeline and will still raise its own approval for anything that
 * reaches another person. It shares the card shell so the log reads as one
 * surface, but never the amber tone, because a card that looks like an
 * approval trains the owner to skim both.
 */
export function SuggestionCard({
  parts,
  timeZone = 'UTC',
}: {
  parts: InlineSuggestionPart[];
  timeZone?: string;
}) {
  const [resolved, setResolved] = useState<Record<string, SuggestionResolution>>({});
  const [taskIds, setTaskIds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const inFlight = useRef(false);
  const [activeDecision, setActiveDecision] = useState<SuggestionStatus | null>(null);

  const statusOf = (part: InlineSuggestionPart): SuggestionStatus =>
    suggestionStatus(part.status, resolved[part.suggestionId]);

  const decide = (suggestionId: string, decision: 'accepted' | 'dismissed') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setActive(suggestionId);
    setActiveDecision(decision);
    startTransition(async () => {
      try {
        const result = await decideSuggestionInline(suggestionId, decision);
        if (result.ok) {
          setResolved((prev) => ({ ...prev, [suggestionId]: { status: decision } }));
          if (result.taskId) {
            setTaskIds((prev) => ({ ...prev, [suggestionId]: result.taskId as string }));
          }
          setError(null);
        } else {
          setError(result.error ?? 'This suggestion could not be updated.');
        }
      } catch {
        setError('This suggestion could not be updated. Try again.');
      } finally {
        inFlight.current = false;
        setActive(null);
        setActiveDecision(null);
      }
    });
  };

  const snooze = (suggestionId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setActive(suggestionId);
    setActiveDecision('snoozed');
    startTransition(async () => {
      try {
        const result = await snoozeSuggestionInline(suggestionId);
        if (result.ok) {
          setResolved((prev) => ({
            ...prev,
            [suggestionId]: {
              status: 'snoozed',
              snoozedUntil: result.snoozedUntil ?? new Date(Date.now() + 86_400_000).toISOString(),
            },
          }));
          setError(null);
        } else {
          setError(result.error ?? 'This suggestion could not be updated.');
        }
      } catch {
        setError('This suggestion could not be updated. Try again.');
      } finally {
        inFlight.current = false;
        setActive(null);
        setActiveDecision(null);
      }
    });
  };

  if (parts.length === 0) return null;

  // Only a live question renders open. A hydrated 'snoozed' means the snooze
  // is still sleeping (an elapsed one already came back as 'pending'), so it
  // settles to a receipt instead of re-asking what the owner just put down.
  const isOpen = (part: InlineSuggestionPart) => statusOf(part) === 'pending';
  const openParts = parts.filter(isOpen);

  const receiptOf = (part: InlineSuggestionPart) => {
    const status = statusOf(part);
    const taskId = taskIds[part.suggestionId] ?? part.acceptedTaskId;
    const context = suggestionContext(part.contextCard);
    const verdict =
      status === 'accepted'
        ? acceptedSuggestionLabel(part.acceptedTaskStatus)
        : status === 'dismissed'
          ? 'Dismissed'
          : status === 'snoozed'
            ? 'Snoozed'
            : status === 'expired'
              ? 'Expired'
              : 'No longer available';
    const wake = suggestionWakeLabel(
      resolved[part.suggestionId]?.snoozedUntil ?? part.snoozedUntil,
      timeZone,
    );
    return (
      <details key={part.suggestionId} className="group/receipt min-w-0">
        <summary
          aria-label={`${context?.title ?? part.summary} — ${verdict}`}
          className={`flex min-w-0 cursor-pointer list-none items-center justify-between gap-2 rounded [&::-webkit-details-marker]:hidden ${focusRing}`}
        >
          <DecisionReceipt
            outcome={
              status === 'accepted' ? 'accepted' : status === 'dismissed' ? 'dismissed' : 'lapsed'
            }
            summary={context?.title ?? part.summary}
            verdict={verdict}
            live={resolved[part.suggestionId] !== undefined}
          />
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted motion-safe:transition-transform group-open/receipt:rotate-180"
          />
        </summary>
        <div className="space-y-2 pt-2 pb-1">
          {context ? (
            <SuggestionContextContent context={context} timeZone={timeZone} />
          ) : (
            <p className="text-sm leading-6 text-strong">{part.summary}</p>
          )}
          {status === 'snoozed' && wake ? (
            <p className="text-xs text-muted">Returns {wake}</p>
          ) : null}
          {status === 'accepted' && taskId ? (
            <Link
              href={`/audit/${taskId}`}
              className="shrink-0 text-xs text-muted underline underline-offset-2"
              prefetch={false}
            >
              View task evidence
            </Link>
          ) : null}
          {status === 'accepted' && part.acceptedTaskSummary ? (
            <p className="break-words text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">
              {part.acceptedTaskSummary}
            </p>
          ) : null}
        </div>
      </details>
    );
  };

  if (openParts.length === 0) {
    return <DecisionReceipts>{parts.map(receiptOf)}</DecisionReceipts>;
  }

  const singleContext = parts.length === 1 ? suggestionContext(parts[0]?.contextCard) : undefined;
  return (
    <DecisionCard
      tone="info"
      icon={singleContext?.category === 'email' ? Mail : Lightbulb}
      label={
        singleContext?.urgencyLabel ||
        (parts.length === 1 ? 'Suggested next step' : `${parts.length.toString()} suggestions`)
      }
    >
      <ul className="flex flex-col gap-3">
        {parts.map((part) => {
          if (!isOpen(part)) return <li key={part.suggestionId}>{receiptOf(part)}</li>;
          const working = busy && active === part.suggestionId;
          const context = suggestionContext(part.contextCard);
          return (
            <li key={part.suggestionId} className="min-w-0 text-sm leading-relaxed">
              {context ? (
                <SuggestionContextContent context={context} timeZone={timeZone} />
              ) : (
                <p className="break-words [overflow-wrap:anywhere]">{part.summary}</p>
              )}
              <DecisionActions>
                <ActionButton
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  pending={working && activeDecision === 'accepted'}
                  pendingLabel="Starting…"
                  onClick={() => decide(part.suggestionId, 'accepted')}
                >
                  {part.actionLabel || 'Start task'}
                </ActionButton>
                <ActionButton
                  size="sm"
                  disabled={busy}
                  pending={working && activeDecision === 'snoozed'}
                  pendingLabel="Saving…"
                  onClick={() => snooze(part.suggestionId)}
                >
                  Later
                </ActionButton>
                <ActionButton
                  size="sm"
                  disabled={busy}
                  pending={working && activeDecision === 'dismissed'}
                  pendingLabel="Dismissing…"
                  onClick={() => decide(part.suggestionId, 'dismissed')}
                >
                  No thanks
                </ActionButton>
              </DecisionActions>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </DecisionCard>
  );
}
