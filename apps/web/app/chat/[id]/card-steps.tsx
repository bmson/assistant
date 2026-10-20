'use client';

/*
 * The work behind an answer card, folded into the card itself.
 *
 * A composed card is assembled from lookups the owner never asked to see. Each
 * of those used to render as its own full-size card in the thread, so one
 * request came back as three surfaces — the answer plus the assistant's
 * homework. The runtime now hands the answer card a step trail
 * (core/workflow/card-steps.ts) and this is where it lands: one quiet row at
 * the bottom of the card, closed until someone wants to know where the numbers
 * came from.
 */
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { focusRing } from '@/lib/ui';
import { stepActionLabel } from '@/lib/views';

/** One tool call, as the card reports it. Mirrors `ResponseCardStep` in core. */
export interface CardStep {
  tool: string;
  count?: string;
  detail?: string;
  failed?: boolean;
  error?: string;
}

/**
 * The trail carried on a card payload. Payloads arrive as unknown jsonb from a
 * server build that may be older or newer than this one, so every field is
 * checked rather than asserted — a malformed step is dropped, never rendered.
 */
export function cardStepsOf(value: unknown): CardStep[] {
  if (!Array.isArray(value)) return [];
  const steps: CardStep[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const step = entry as Record<string, unknown>;
    if (typeof step.tool !== 'string' || step.tool.trim() === '') continue;
    steps.push({
      tool: step.tool,
      ...(typeof step.count === 'string' && step.count ? { count: step.count } : {}),
      ...(typeof step.detail === 'string' && step.detail ? { detail: step.detail } : {}),
      ...(step.failed === true ? { failed: true } : {}),
      ...(typeof step.error === 'string' && step.error ? { error: step.error } : {}),
    });
  }
  return steps;
}

/** "Found in 3 steps, 1 failed" — what the closed row says it is hiding. */
function collapsedLabel(steps: CardStep[]): string {
  const failed = steps.filter((step) => step.failed).length;
  const found = `Found in ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return failed === 0 ? found : `${found}, ${failed} failed`;
}

function StepRow({ step }: { step: CardStep }) {
  return (
    <li className="min-w-0 rounded-lg border border-edge/60 bg-raised/60 px-3 py-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-medium text-strong">
          {stepActionLabel(step.tool)}
        </span>
        {step.count ? <span className="shrink-0 text-[11px] text-muted">{step.count}</span> : null}
      </div>
      {/* A failure gets its own line rather than the count's slot: a reason is
          a sentence, and squeezed onto the right of the row it either
          truncated to nothing or pushed the action name off the edge. */}
      {step.failed ? (
        <p className="mt-0.5 break-words text-[11px] leading-4 text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
          {step.error ?? 'Did not finish'}
        </p>
      ) : null}
      {step.detail ? (
        <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-muted [overflow-wrap:anywhere]">
          {step.detail}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The collapsed provenance row, and the panel it opens.
 *
 * Closed by default and never opened for you: the card answered the question,
 * and this is only here for the reader who wants to check it. Opening it moves
 * no focus and scrolls nothing — the list grows downward inside the card, and
 * past four steps it scrolls in place rather than growing the card without
 * bound.
 */
export function CardSteps({ steps }: { steps: CardStep[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // A turn that called no tools has no provenance to reach for, and an empty
  // disclosure is a promise of detail that isn't there.
  if (steps.length === 0) return null;
  return (
    <div data-message-utility="true" className="mt-3 border-t border-edge/60 pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`mobile-touch-target flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-xs font-medium text-muted motion-safe:transition-colors hover:bg-sunken/60 hover:text-strong ${focusRing}`}
      >
        {/* Hover is the desktop cue and does not exist on touch, so the row
            carries its own marks: a bullet that says "this is a thing", and a
            chevron that says which way it goes. */}
        <span aria-hidden="true" className="shrink-0 text-accent">
          •
        </span>
        <span className="min-w-0 flex-1">{open ? 'Hide steps' : collapsedLabel(steps)}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 shrink-0 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {/* `hidden` rather than unmounted: the panel aria-controls points at
          stays in the document, and a hidden subtree is out of the
          accessibility tree, so a screen reader walks past the closed steps
          exactly as a sighted reader does. */}
      <ul
        id={panelId}
        hidden={!open}
        className="mt-2 flex max-h-52 min-w-0 flex-col gap-1.5 overflow-y-auto rounded-xl bg-sunken/55 p-2"
      >
        {steps.map((step, index) => (
          <StepRow key={`${step.tool}-${index.toString()}`} step={step} />
        ))}
      </ul>
    </div>
  );
}
