import { describe, expect, it } from 'vitest';
import {
  calendarAgendaCards,
  calendarAgendaScopedEvidence,
  wantsCalendarAgenda,
} from './calendar-agenda.js';
import type { PersonalReadRequest } from './read-intent.js';
import type { ResponseCard } from './response-cards.js';
import type { ActionEvidence } from './response-contract.js';

function request(overrides: Partial<PersonalReadRequest> = {}): PersonalReadRequest {
  return {
    kind: 'calendar',
    queryTerms: [],
    firstToolName: 'calendar.list_events',
    requiresThreadRead: false,
    timeZone: 'America/Los_Angeles',
    timeWindow: {
      timeMin: '2026-10-22T07:00:00.000Z',
      timeMax: '2026-10-23T07:00:00.000Z',
      label: 'tomorrow',
    },
    ...overrides,
  };
}

function evidence(
  result: Record<string, unknown> = { ok: true, complete: true, calendarsSearched: ['Work'] },
  overrides: Partial<ActionEvidence> = {},
): ActionEvidence {
  return {
    toolName: 'calendar.list_events',
    status: 'succeeded',
    args: { timeMin: '2026-10-22T07:00:00.000Z', timeMax: '2026-10-23T07:00:00.000Z' },
    result,
    ...overrides,
  };
}

function event(
  id: string,
  start: string,
  end: string,
  overrides: Record<string, unknown> = {},
): ResponseCard {
  return {
    kind: 'calendar-event',
    id,
    title: id,
    start,
    end,
    allDay: false,
    blocksTime: true,
    calendars: ['Work'],
    calendarLinks: [],
    ...overrides,
  };
}

const agenda = (cards: ResponseCard[]) =>
  cards.flatMap((card) =>
    Array.isArray(card.sections)
      ? (card.sections as Array<Record<string, unknown>>).filter(
          (section) => section.type === 'agenda',
        )
      : [],
  );

const items = (cards: ResponseCard[]) =>
  agenda(cards).flatMap((section) =>
    Array.isArray(section.items) ? (section.items as Array<Record<string, unknown>>) : [],
  );

describe('calendarAgendaCards', () => {
  it('marks a complete final page complete and a dangling page partial', () => {
    const eventRows = [event('standup', '2026-10-22T16:00:00Z', '2026-10-22T16:30:00Z')];
    const complete = calendarAgendaCards({
      evidence: [evidence()],
      events: eventRows,
      request: request(),
    });
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ complete: true, lead: '1 event from Work.' });
    expect(agenda(complete)[0]).toMatchObject({ complete: true });

    const partial = calendarAgendaCards({
      evidence: [
        evidence({
          ok: true,
          complete: false,
          nextPageToken: 'page-2',
          calendarsSearched: ['Work'],
        }),
      ],
      events: eventRows,
      request: request(),
    });
    expect(partial[0]).toMatchObject({ complete: false });
    expect(partial[0]?.lead).toContain('Coverage is incomplete');
    expect(agenda(partial)[0]).toMatchObject({ complete: false });
  });

  it('closes coverage only when every page chain reaches a complete final page', () => {
    const first = evidence(
      { ok: true, complete: false, nextPageToken: 'page-2', calendarsSearched: ['Work'] },
      { step: 1 },
    );
    const second = evidence(
      { ok: true, complete: true, calendarsSearched: ['Work'] },
      {
        step: 2,
        args: {
          timeMin: '2026-10-22T07:00:00.000Z',
          timeMax: '2026-10-23T07:00:00.000Z',
          pageToken: 'page-2',
        },
      },
    );
    const cards = calendarAgendaCards({
      evidence: [first, second],
      events: [],
      request: request(),
    });
    expect(cards[0]).toMatchObject({ complete: true });
    expect(cards[0]?.lead).toContain('No events on Work');
  });

  it('distinguishes read failures, unresolved names, and permission coverage gaps', () => {
    const failure = calendarAgendaCards({
      evidence: [evidence({ ok: false, complete: false }, { status: 'failed' })],
      events: [],
      request: request(),
    });
    expect(failure[0]).toMatchObject({ complete: false });
    expect(failure[0]?.lead).toMatch(/Couldn’t load/);

    const scoped = request({ calendarScope: { name: 'Zendesk' } });
    const scopeArgs = { calendarIds: ['Zendesk'] };
    const unresolved = calendarAgendaCards({
      evidence: [
        evidence(
          {
            ok: true,
            complete: false,
            events: [],
            calendarsSearched: [],
            unavailable: [
              { calendar: 'Zendesk', reason: 'calendar was not found in the readable roster' },
            ],
          },
          { args: scopeArgs },
        ),
      ],
      events: [],
      request: scoped,
    });
    expect(unresolved[0]?.lead).toMatch(/Couldn’t resolve Zendesk/);
    expect(unresolved[0]?.lead).toMatch(/Which calendar should I use/);

    const denied = calendarAgendaCards({
      evidence: [
        evidence(
          {
            ok: true,
            complete: false,
            events: [],
            calendarsSearched: ['Zendesk'],
            unavailable: [{ calendar: 'Zendesk', reason: 'Google API 403: access denied' }],
          },
          { args: scopeArgs },
        ),
      ],
      events: [],
      request: scoped,
    });
    expect(denied[0]?.lead).toContain('Coverage is incomplete');
    expect(denied[0]?.lead).not.toContain('Which calendar should I use');
    expect(denied[0]?.lead).not.toContain('No events on');
  });

  it('ignores prior-task reads and invalidates mismatched named-calendar evidence', () => {
    const prior = evidence(undefined, { fromCurrentTask: false });
    expect(calendarAgendaCards({ evidence: [prior], events: [], request: request() })).toEqual([]);

    const scopedRequest = request({ calendarScope: { name: 'Work' } });
    const mismatch = evidence(undefined, { args: { calendarIds: ['Personal Work'] } });
    const guarded = calendarAgendaScopedEvidence([mismatch], scopedRequest);
    expect(guarded[0]).toMatchObject({
      status: 'failed',
      result: { ok: false, complete: false, scopeMismatch: true },
    });
  });

  it('keeps all 13 supplied rows and sorts all-day rows before timed rows chronologically', () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(
        `event-${index + 1}`,
        `2026-10-22T${String(18 + Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 10).padStart(2, '0')}:00Z`,
        `2026-10-22T${String(18 + Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 10 + 5).padStart(2, '0')}:00Z`,
      ),
    );
    events.push(event('all-day', '2026-10-22', '2026-10-23', { allDay: true }));
    const cards = calendarAgendaCards({ evidence: [evidence()], events, request: request() });
    const rows = items(cards);
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ id: 'all-day', time: 'All day' });
    expect(rows.slice(1).map((row) => row.id)).toEqual(
      [...events]
        .filter((row) => row.id !== 'all-day')
        .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)))
        .map((row) => row.id),
    );
  });

  it('retains multiday end dates and reports same-day overlaps without claiming attendance', () => {
    const events = [
      event('overnight', '2026-10-22T23:30:00Z', '2026-10-23T00:30:00Z'),
      event('overlap', '2026-10-22T23:45:00Z', '2026-10-23T00:15:00Z'),
    ];
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events,
      request: request({ timeZone: 'UTC' }),
    });
    expect(items(cards)).toHaveLength(2);
    expect(items(cards)[0]?.time).toContain('Friday, Oct 23, 2026');
    const attention = cards[0]?.sections as Array<Record<string, unknown>>;
    const overlapSection = attention.find(
      (section) => section.type === 'attention' && section.overlaps,
    );
    expect(overlapSection?.overlaps).toMatchObject([
      { detail: 'overnight · overlap. Calendar overlap does not confirm attendance.' },
    ]);
  });

  it('omits overlap warnings when the owner explicitly opted out', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('one', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z'),
        event('two', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z'),
      ],
      request: request({ timeZone: 'UTC', includeCalendarOverlapSummary: false }),
    });
    expect(items(cards)).toHaveLength(2);
    expect(cards[0]?.sections).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: expect.stringMatching(/overlap/) }),
      ]),
    );
  });

  it('places malformed source dates in an unverified section without throwing', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [event('bad-date', 'not-a-date', 'also-not-a-date')],
      request: request(),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.date).toBe('Dates not verified');
    expect(items(cards)[0]).toMatchObject({ id: 'bad-date', time: 'Time unavailable' });
    expect(cards[0]?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'attention', title: 'Dates not verified' }),
      ]),
    );
  });
});

describe('wantsCalendarAgenda', () => {
  it('applies to calendar requests but excludes specialized reads and incidental calendars', () => {
    expect(wantsCalendarAgenda(request())).toBe(true);
    expect(wantsCalendarAgenda(null, 'What is on my agenda?')).toBe(true);
    expect(wantsCalendarAgenda(request({ kind: 'email' }))).toBe(false);
    for (const overrides of [
      { answerFocus: 'flight' as const },
      { sourceReads: [] },
      { personCalendar: { name: 'Maya' } },
      { weeklyCalendarPlan: true },
      { calendarEventAnalysis: { kind: 'duration' } as never },
      { compoundTripDiscovery: true },
      { upcomingFlightDiscovery: true },
      { firstToolName: 'calendar.availability' as const },
    ]) {
      expect(wantsCalendarAgenda(request(overrides))).toBe(false);
    }
    expect(wantsCalendarAgenda(null, 'Tell me a joke.')).toBe(false);
  });
});
