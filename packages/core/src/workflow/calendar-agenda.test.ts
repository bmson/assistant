import { describe, expect, it } from 'vitest';
import {
  calendarAgendaCards,
  calendarAgendaScopedEvidence,
  wantsCalendarAgenda,
} from './calendar-agenda.js';
import { calendarRelationship } from './calendar-relationship.js';
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
    expect(complete[0]).toMatchObject({ complete: true, lead: '1 calendar entry from Work.' });
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
    events.push(
      event('all-day', '2026-10-22', '2026-10-23', {
        allDay: true,
        calendarTimeZone: 'UTC',
      }),
    );
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
      {
        detail:
          'overnight (Calendar) · overlap (Calendar). Your attendance is not confirmed for both events.',
      },
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

  it('places cross-midnight overlaps on the actual local overlap day', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('late', '2026-10-23T23:30:00Z', '2026-10-24T01:00:00Z'),
        event('early', '2026-10-24T00:30:00Z', '2026-10-24T01:30:00Z'),
      ],
      request: request({
        timeZone: 'UTC',
        timeWindow: {
          timeMin: '2026-10-23T00:00:00Z',
          timeMax: '2026-10-25T00:00:00Z',
          label: 'two days',
        },
      }),
    });
    const dayAfter = cards.find((card) => String(card.date).startsWith('Saturday, Oct 24'));
    const sections = dayAfter?.sections as Array<Record<string, unknown>>;
    expect(sections.find((section) => section.overlaps)?.overlaps).toMatchObject([
      { title: 'Possible overlap: 12:30 AM – 1:00 AM' },
    ]);
    const firstDaySections = cards[0]?.sections as Array<Record<string, unknown>>;
    expect(firstDaySections.some((section) => section.overlaps)).toBe(false);
  });

  it('keeps every agenda row while bounding dense overlap details and reporting the exact omitted count', () => {
    const count = 2_000;
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: Array.from({ length: count }, (_, index) =>
        event(`dense-${index}`, '2026-10-22T09:00:00Z', '2026-10-22T10:00:00Z', {
          calendarId: `calendar-${index}`,
          eventId: `event-${index}`,
          title: `Dense meeting ${index}`,
        }),
      ),
      request: request({ timeZone: 'UTC' }),
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    const overlap = sections.find((section) => section.overlaps);
    const details = overlap?.overlaps as unknown[];
    expect(items(cards)).toHaveLength(count);
    expect(details).toHaveLength(100);
    expect(overlap).toMatchObject({
      overlapCount: (count * (count - 1)) / 2,
      overlapsTruncated: true,
    });
    expect(overlap?.title).toBe('Many overlapping listings');
    expect(JSON.stringify(overlap?.items)).toContain(
      '1,998,900 additional pairs counted but not expanded; 100 detail previews are available',
    );
    expect(JSON.stringify(overlap?.items)).not.toMatch(
      /accepted commitment conflict|other overlap/,
    );
    expect(JSON.stringify(cards).length).toBeLessThan(2_000_000);
  });

  it('caps formatted pair details across the whole response while preserving per-day counts', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: Array.from({ length: 120 }, (_, index) => {
        const dayOffset = Math.floor(index / 10);
        const date = new Date(Date.parse('2026-10-22T00:00:00Z') + dayOffset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return event(`multi-day-${index}`, `${date}T09:00:00Z`, `${date}T10:00:00Z`, {
          calendarId: `calendar-${index}`,
          eventId: `event-${index}`,
        });
      }),
      request: request({ timeZone: 'UTC' }),
    });
    const overlapSections = cards.flatMap((card) =>
      (card.sections as Array<Record<string, unknown>>).filter((section) => section.overlaps),
    );
    expect(overlapSections.reduce((sum, section) => sum + Number(section.overlapCount), 0)).toBe(
      540,
    );
    expect(
      overlapSections.reduce((sum, section) => sum + (section.overlaps as unknown[]).length, 0),
    ).toBe(100);
    expect(
      overlapSections.reduce(
        (sum, section) =>
          sum + Number(section.overlapCount) - (section.overlaps as unknown[]).length,
        0,
      ),
    ).toBe(440);
  });

  it('surfaces canonical source differences in the row note and attention section', () => {
    const card = event('canonical-planning', '2026-10-22T09:00:00Z', '2026-10-22T10:00:00Z', {
      title: 'Planning',
      sourceVariants: [
        {
          calendarId: 'work',
          calendar: 'Work',
          summary: 'Planning',
          start: '2026-10-22T09:00:00Z',
          end: '2026-10-22T10:00:00Z',
          allDay: true,
          calendarTimeZone: 'America/Los_Angeles',
          location: 'Office',
          status: 'confirmed',
          blocksTime: true,
          calendarPurpose: 'commitments',
          ownerParticipation: {
            status: 'accepted',
            identityVerified: true,
            basis: 'attendee-email',
          },
        },
        {
          calendarId: 'family',
          calendar: 'Family',
          summary: 'Planning hold',
          start: '2026-10-23T09:30:00Z',
          end: '2026-10-23T10:30:00Z',
          allDay: false,
          calendarTimeZone: 'UTC',
          location: 'Home',
          status: 'tentative',
          blocksTime: false,
          calendarPurpose: 'reference',
          ownerResponse: 'needsAction',
        },
      ],
    });
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [card],
      request: request({ timeZone: 'UTC' }),
    });
    expect(cards[0]?.date).toBe('Dates not verified');
    expect(items(cards)[0]).toMatchObject({
      day: 'Time unavailable',
      title: 'Title differs by source',
      time: 'Time unavailable',
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    const differences = sections.find((section) => section.title === 'Calendar source differences');
    expect(differences?.items).toMatchObject([
      {
        title: 'Source titles differ · Planning',
      },
    ]);
    expect(JSON.stringify(differences?.items)).toContain('Work: title Planning');
    expect(JSON.stringify(differences?.items)).toContain('Family: title Planning hold');
    expect(JSON.stringify(differences?.items)).toContain('; time All day');
    expect(JSON.stringify(differences?.items)).toContain(
      'time Friday, Oct 23, 2026 9:30 AM – 10:30 AM (UTC)',
    );
    expect(JSON.stringify(differences?.items)).toContain('location Office');
    expect(JSON.stringify(differences?.items)).toContain('calendar purpose commitments');
    expect(JSON.stringify(differences?.items)).toContain('provider copy asks for a response');
    expect(JSON.stringify(differences?.items)).not.toContain('needsAction');
    expect(items(cards)[0]?.note).toContain(
      'Calendar copies differ in title, time, event type, time zone, location, status, busy state, response metadata, calendar purpose.',
    );
  });

  it('describes different source times as possible copies, not as a personal conflict', () => {
    const accepted = {
      status: 'accepted',
      identityVerified: true,
      basis: 'attendee-email',
    } as const;
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('work-event', '2026-10-22T17:00:00Z', '2026-10-22T18:00:00Z', {
          title: 'Planning',
          calendarId: 'work',
          eventId: 'work-event',
          iCalUID: 'shared-uid',
          blocksTime: true,
          ownerParticipation: accepted,
        }),
        event('family-event', '2026-10-22T17:05:00Z', '2026-10-22T18:05:00Z', {
          title: 'Planning',
          calendarId: 'family',
          eventId: 'family-event',
          iCalUID: 'shared-uid',
          blocksTime: true,
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
    });
    const sections = cards.flatMap((card) =>
      Array.isArray(card.sections) ? (card.sections as Record<string, unknown>[]) : [],
    );
    expect(sections.some((section) => String(section.title).includes('possible copy pair'))).toBe(
      true,
    );
    expect(sections.some((section) => Number(section.overlapCount) > 0)).toBe(false);
    expect(JSON.stringify(sections)).toContain('Possible copies with different times');
    expect(JSON.stringify(sections)).toContain(
      'Assistant cannot confirm whether these are the same event or which time is current.',
    );
    expect(JSON.stringify(sections)).not.toMatch(
      /trusted event UID|occurrence metadata|source identity/i,
    );
    expect(JSON.stringify(sections)).not.toContain('personal commitment conflict');
  });

  it('summarizes exact overlap classes only when all pair details are retained', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('accepted-1', '2026-10-22T09:00:00Z', '2026-10-22T10:00:00Z', {
          ownerParticipation: accepted,
        }),
        event('accepted-2', '2026-10-22T09:30:00Z', '2026-10-22T10:30:00Z', {
          ownerParticipation: accepted,
        }),
        event('unknown-1', '2026-10-22T11:00:00Z', '2026-10-22T12:00:00Z'),
        event('unknown-2', '2026-10-22T11:30:00Z', '2026-10-22T12:30:00Z'),
      ],
      request: request({ timeZone: 'UTC' }),
    });
    const overlap = ((cards[0]?.sections ?? []) as Array<Record<string, unknown>>).find(
      (section) => section.overlaps,
    );
    expect(overlap?.title).toBe('1 accepted commitment conflict · 1 other overlap');
    expect(JSON.stringify(overlap?.overlaps)).toContain(
      'You accepted both invitations, and the times overlap.',
    );
    expect(JSON.stringify(overlap?.overlaps)).toContain(
      'Your attendance is not confirmed for both events.',
    );
  });

  it('groups timed source instants in the owner display zone despite source-zone differences', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('source-zone-event', '2026-10-23T01:00:00Z', '2026-10-23T02:00:00Z', {
          title: 'Late meeting',
          sourceVariants: [
            {
              calendarId: 'work',
              eventId: 'event',
              start: '2026-10-23T01:00:00Z',
              end: '2026-10-23T02:00:00Z',
              allDay: false,
              calendarTimeZone: 'UTC',
            },
            {
              calendarId: 'family',
              eventId: 'copy',
              start: '2026-10-22T18:00:00-07:00',
              end: '2026-10-22T19:00:00-07:00',
              allDay: false,
              calendarTimeZone: 'America/Los_Angeles',
            },
          ],
        }),
      ],
      request: request(),
    });
    expect(cards[0]?.date).toContain('Thursday, Oct 22');
    expect(JSON.stringify(cards[0]?.sections)).not.toContain('Dates not verified');
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const sourceDiffs = JSON.stringify(
      sections.find((section) => section.title === 'Calendar source differences'),
    );
    expect(sourceDiffs).toContain('Friday, Oct 23, 2026 1:00 AM – 2:00 AM (UTC)');
    expect(sourceDiffs).toContain('Thursday, Oct 22, 2026 6:00 PM – 7:00 PM (America/Los_Angeles)');
    expect(sourceDiffs).toContain('same meeting time in different calendar time zones');
    expect(sections).toMatchObject([
      { type: 'agenda' },
      {
        title: 'Calendar source differences',
      },
    ]);
    expect(JSON.stringify(sections)).not.toContain('differ in time zone, time');
  });

  it('separates probable phone mirrors and uses explicit arrival guidance', () => {
    const first = event('arrival', '2026-10-22T18:15:00Z', '2026-10-22T20:30:00Z', {
      calendarId: 'google',
      location: '100 Example Road',
      sourceVariants: [
        {
          calendarId: 'google',
          eventId: 'arrival',
          summary: 'United Albion arrival',
          description: 'Venue aliases: Example Field',
          location: '100 Example Road',
          start: '2026-10-22T18:15:00Z',
          end: '2026-10-22T20:30:00Z',
        },
      ],
    });
    const kickoff = event('kickoff', '2026-10-22T19:00:00Z', '2026-10-22T20:30:00Z', {
      calendarId: 'team',
      description: 'Arrival: 45 minutes in advance',
      location: 'Example Field',
      sourceVariants: [
        {
          calendarId: 'team',
          eventId: 'kickoff',
          summary: 'United Albion kickoff',
          description: 'Arrival: 45 minutes in advance',
          location: 'Example Field',
          start: '2026-10-22T19:00:00Z',
          end: '2026-10-22T20:30:00Z',
        },
      ],
    });
    expect(
      calendarRelationship(
        {
          summary: 'United Albion arrival',
          start: '2026-10-22T18:15:00Z',
          end: '2026-10-22T20:30:00Z',
          allDay: false,
          calendar: 'Family',
          calendarId: 'google',
          location: '100 Example Road',
          description: 'Venue aliases: Example Field',
        },
        {
          summary: 'United Albion kickoff',
          start: '2026-10-22T19:00:00Z',
          end: '2026-10-22T20:30:00Z',
          allDay: false,
          calendar: 'Team',
          calendarId: 'team',
          location: 'Example Field',
          description: 'Arrival: 45 minutes in advance',
        },
      ),
    ).toBe('compatible_time_roles');
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [first, kickoff],
      request: request({ timeZone: 'UTC' }),
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    expect(
      String(
        sections.find((section) => String(section.title).includes('arrival and start'))?.title,
      ),
    ).toContain('1 possible arrival and start pair');
    expect(sections.some((section) => String(section.title).includes('possible overlap'))).toBe(
      false,
    );
    const mirror = (calendarId: string, id: string) =>
      event(id, '2026-10-22T21:00:00Z', '2026-10-22T22:00:00Z', {
        title: 'Dentist',
        sourceVariants: [
          {
            calendarId,
            eventId: id,
            summary: 'Dentist',
            start: '2026-10-22T21:00:00Z',
            end: '2026-10-22T22:00:00Z',
          },
        ],
      });
    const mirrorCards = calendarAgendaCards({
      evidence: [evidence()],
      events: [mirror('google', 'google-dentist'), mirror('iphone:work', 'phone-dentist')],
      request: request({ timeZone: 'UTC' }),
    });
    const mirrorSections = mirrorCards[0]?.sections as Array<Record<string, unknown>>;
    expect(mirrorSections.some((section) => section.overlaps)).toBe(false);
    expect(mirrorSections.some((section) => String(section.title).includes('possible copy'))).toBe(
      true,
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
