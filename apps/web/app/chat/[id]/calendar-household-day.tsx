'use client';

import {
  calendarHouseholdItemHasAcceptedRSVP,
  parseCalendarHouseholdComparison,
  parseCalendarHouseholdDay,
  parseCalendarHouseholdItem,
} from '@assistant/persistence/calendar-household-day';
import { type ReactNode, useRef } from 'react';
import { btn, focusRing, summaryClass } from '@/lib/ui';

type Raw = Record<string, unknown>;
type ItemDetails = NonNullable<ReturnType<typeof parseCalendarHouseholdItem>>;
type IndexedItem = { id: string; title: string; time: string; details: ItemDetails | null };
export type CalendarHouseholdIndex = ReadonlyMap<string, IndexedItem | null>;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const record = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;

/** Index actual rows once; duplicate or absent IDs cannot support a comparison. */
export function calendarHouseholdIndex(sections: readonly Raw[]): CalendarHouseholdIndex {
  const index = new Map<string, IndexedItem | null>();
  for (const section of sections) {
    if (section.type !== 'agenda' || !Array.isArray(section.items)) continue;
    for (const value of section.items) {
      const item = record(value);
      const id = text(item?.id);
      if (!item || !id) continue;
      index.set(
        id,
        index.has(id)
          ? null
          : {
              id,
              title: text(item.title),
              time: text(item.time),
              details: parseCalendarHouseholdItem(item.householdDetails),
            },
      );
    }
  }
  return index;
}

function Disclosure({
  label,
  accessibleLabel = label,
  closeLabel = 'Close details',
  children,
}: {
  label: string;
  accessibleLabel?: string;
  closeLabel?: string;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  return (
    <details ref={details} className="min-w-0">
      <summary
        ref={summary}
        aria-label={accessibleLabel}
        className={`${summaryClass} min-h-11 max-w-full text-sm [overflow-wrap:anywhere] ${focusRing}`}
      >
        {label}
      </summary>
      <div className="grid min-w-0 gap-3 rounded-lg border border-edge/60 bg-sunken/50 p-3">
        {children}
        <button
          type="button"
          className={`${btn.outline} justify-self-start`}
          onClick={() => {
            if (details.current) details.current.open = false;
            summary.current?.focus();
          }}
        >
          {closeLabel}
        </button>
      </div>
    </details>
  );
}

const rsvpLabels = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needs a response',
  unknown: 'unknown',
  not_verified: 'not verified',
} as const;

// Display-only keys retain repeated identical source facts without assigning a
// provider identity or changing occurrence grouping.
function displayEntries<T>(values: readonly T[]) {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = JSON.stringify(value);
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    return { value, key: `${base}:${count}` };
  });
}

function EventEvidence({ details }: { details: ItemDetails }) {
  return (
    <>
      <dl className="grid min-w-0 gap-2">
        <div>
          <dt className="text-sm font-medium text-strong">For</dt>
          <dd className="text-base text-muted">Not stated</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-strong">Driving</dt>
          <dd className="text-base text-muted">Not stated</dd>
        </div>
      </dl>
      <p className="text-sm text-muted">
        A calendar RSVP does not confirm attendance or driving responsibility.
      </p>
      {displayEntries(details.sources).map(({ value: source, key }, index) => (
        <section
          key={key}
          className="grid min-w-0 gap-1 border-t border-edge/60 pt-3 [overflow-wrap:anywhere]"
          aria-label={`Calendar source ${index + 1}`}
        >
          <h5 className="text-sm font-medium text-strong">{source.calendar}</h5>
          <p className="text-base text-strong">{source.title}</p>
          <p className="text-base text-strong">Your RSVP: {rsvpLabels[source.rsvp]}</p>
          <p className="text-sm text-muted">
            {source.allDay ? 'All-day source dates: ' : 'Source time: '}
            {source.start}
            {source.end ? ` to ${source.end}${source.allDay ? ' (end exclusive)' : ''}` : ''}
          </p>
          <p className="text-sm text-muted">
            {source.timeZone
              ? `Source time zone: ${source.timeZone}`
              : 'Source time zone not reported.'}
          </p>
        </section>
      ))}
    </>
  );
}

export function CalendarHouseholdEventDetails({ value, title }: { value: unknown; title: string }) {
  const details = parseCalendarHouseholdItem(value);
  if (!details) return null;
  return (
    <Disclosure label="Details" accessibleLabel={`Details for ${title}`}>
      <EventEvidence details={details} />
    </Disclosure>
  );
}

function comparisonItems(value: unknown, index: CalendarHouseholdIndex) {
  const comparison = parseCalendarHouseholdComparison(value);
  if (!comparison) return null;
  const left = index.get(comparison.leftEventId);
  const right = index.get(comparison.rightEventId);
  return left?.details && right?.details ? [left, right] : null;
}

export function CalendarHouseholdComparison({
  value,
  index,
  label = 'Compare listings',
}: {
  value: unknown;
  index: CalendarHouseholdIndex;
  label?: string;
}) {
  const items = comparisonItems(value, index);
  if (!items) return null;
  return (
    <Disclosure label={label} closeLabel="Close comparison">
      <p className="text-sm text-muted">
        Both listings remain in the agenda with their source times.
      </p>
      {items.map((item, position) => (
        <section
          key={item.id}
          className="grid min-w-0 gap-2 border-t border-edge/60 pt-3 [overflow-wrap:anywhere]"
          aria-label={`Listing ${position + 1}`}
        >
          <h4 className="text-base font-medium text-strong">{item.title}</h4>
          <p className="text-sm text-muted">{item.time}</p>
          {item.details ? <EventEvidence details={item.details} /> : null}
        </section>
      ))}
    </Disclosure>
  );
}

export function CalendarHouseholdSummary({
  value,
  index,
}: {
  value: unknown;
  index: CalendarHouseholdIndex;
}) {
  const day = parseCalendarHouseholdDay(value);
  if (!day) return null;
  const question = day.nextQuestion;
  const comparison = question
    ? { version: 1, leftEventId: question.eventIds[0], rightEventId: question.eventIds[1] }
    : null;
  const pair = comparisonItems(comparison, index);
  const supportedQuestion =
    question && pair?.every((item) => calendarHouseholdItemHasAcceptedRSVP(item.details));
  return (
    <div className="mb-3 grid min-w-0 gap-3">
      <section aria-label="Checked calendar coverage" className="grid min-w-0 gap-1">
        <p className="text-sm font-medium text-strong [overflow-wrap:anywhere]">
          {day.coverage.summary}
        </p>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">
          {day.coverage.freshnessSummary}
        </p>
        <Disclosure label="Sources and freshness">
          <dl className="grid min-w-0 gap-3">
            {displayEntries(day.coverage.details).map(({ value: detail, key }) => (
              <div key={key} className="min-w-0 [overflow-wrap:anywhere]">
                <dt className="text-sm font-medium text-strong">{detail.title}</dt>
                <dd className="text-base text-muted">{detail.detail}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      </section>
      {supportedQuestion && question ? (
        <section
          aria-label="Next question"
          className="grid min-w-0 gap-2 rounded-lg border border-edge/60 bg-sunken p-3 [overflow-wrap:anywhere]"
        >
          <h4 className="text-base font-medium text-strong">{question.question}</h4>
          <p className="text-sm text-muted">{question.detail}</p>
          {question.remainingIssueCount > 0 ? (
            <p className="text-sm text-muted">
              {question.remainingIssueCount} other calendar pair{' '}
              {question.remainingIssueCount === 1 ? 'notice remains' : 'notices remain'} in the
              agenda details.
            </p>
          ) : null}
          <CalendarHouseholdComparison
            value={comparison}
            index={index}
            label="Review both events"
          />
        </section>
      ) : null}
    </div>
  );
}
