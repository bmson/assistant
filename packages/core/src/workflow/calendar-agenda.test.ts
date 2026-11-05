import { describe, expect, it } from 'vitest';
import {
  calendarAgendaCards,
  calendarAgendaScopedEvidence,
  calendarAgendaSummary,
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
    expect(complete[0]?.householdDay).toMatchObject({
      coverage: { freshnessSummary: 'No source freshness timestamp was reported by this read.' },
    });
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

  it('projects verified source RSVP and only asks about driving for an explicit verified clash', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const events = [
      event('a', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
        title: 'Workshop',
        ownerParticipation: accepted,
      }),
      event('b', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
        title: 'Piano',
        ownerParticipation: accepted,
      }),
      event('c', '2026-10-22T18:00:00Z', '2026-10-22T19:00:00Z', {
        title: 'Dinner',
        ownerParticipation: accepted,
      }),
      event('d', '2026-10-22T18:30:00Z', '2026-10-22T19:30:00Z', {
        title: 'Call',
        ownerParticipation: accepted,
      }),
    ];
    const withoutOwnerRelevance = calendarAgendaCards({
      evidence: [evidence()],
      events,
      request: request(),
    });
    expect(withoutOwnerRelevance[0]?.householdDay).not.toHaveProperty('nextQuestion');

    const withOwnerRelevance = calendarAgendaCards({
      evidence: [evidence()],
      events,
      request: request(),
      requestText: 'Show my agenda. Who is driving between these commitments?',
    });
    expect(withOwnerRelevance[0]?.householdDay).toMatchObject({
      coverage: { complete: true },
      nextQuestion: {
        basis: 'verified_owner_accepted_overlap',
        eventIds: ['a', 'b'],
        remainingIssueCount: 1,
        detail: 'These accepted commitments overlap. Driving is not stated.',
      },
    });
    const projected = items(withOwnerRelevance);
    expect(projected[0]?.householdDetails).toMatchObject({
      version: 1,
      sources: [{ rsvp: 'accepted' }],
      eventFor: 'not_stated',
      driving: 'not_stated',
    });
    expect(calendarAgendaSummary(withOwnerRelevance as Array<Record<string, unknown>>)).toContain(
      'RSVP by source: Work: accepted. Event for: not stated. Driving: not stated.',
    );
    expect(calendarAgendaSummary(withOwnerRelevance as Array<Record<string, unknown>>)).toContain(
      'Next question:',
    );
    const curlyContraction = calendarAgendaCards({
      evidence: [evidence()],
      events,
      request: request(),
      requestText: 'Show my agenda. Who’s driving?',
    });
    expect(curlyContraction[0]?.householdDay).toHaveProperty('nextQuestion');
    for (const requestText of [
      "Show my agenda. Don't ask who is driving?",
      'Show my agenda. Don’t ask who is driving?',
      'Show my agenda. Shouldn’t ask who is driving?',
      'Show my agenda. Can’t ask who is driving?',
      'Translate "Who is driving?"',
      '"Who is driving?"',
      '`Who is driving?`',
      'Show my agenda. "Who is driving?" is the text on an invitation.',
      'Show my agenda. Translate who is driving?',
      'Show my agenda. My spouse asks who is driving?',
      "Show my agenda. The note says 'Who is driving?'",
      'Show my agenda. The note says ‘Who is driving?’',
    ]) {
      const guarded = calendarAgendaCards({
        evidence: [evidence()],
        events,
        request: request(),
        requestText,
      });
      expect(guarded[0]?.householdDay?.nextQuestion, requestText).toBeUndefined();
      if (requestText.startsWith('Show my agenda.')) {
        expect(items(guarded)).toHaveLength(projected.length);
        expect(guarded[0]?.counts).toEqual(withOwnerRelevance[0]?.counts);
      }
    }
  });

  it('keeps contradictory source RSVP values and binds compare only to distinct actual event IDs', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('work-row', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          sourceVariants: [
            {
              calendar: 'Work',
              calendarId: 'google:work',
              eventId: 'work-row',
              summary: 'Workshop',
              start: '2026-10-22T16:00:00Z',
              end: '2026-10-22T17:00:00Z',
              allDay: false,
              iCalUID: 'shared',
              originalStartTime: '2026-10-22T16:00:00Z',
              ownerParticipation: {
                status: 'accepted',
                identityVerified: true,
                basis: 'attendee-email',
              },
            },
            {
              calendar: 'Backup',
              calendarId: 'google:backup',
              eventId: 'work-copy',
              summary: 'Workshop',
              start: '2026-10-22T16:00:00Z',
              end: '2026-10-22T17:00:00Z',
              allDay: false,
              iCalUID: 'shared',
              originalStartTime: '2026-10-22T16:00:00Z',
              ownerParticipation: {
                status: 'declined',
                identityVerified: true,
                basis: 'attendee-email',
              },
            },
          ],
        }),
        event('phone-row', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          sourceVariants: [
            {
              calendar: 'Phone',
              calendarId: 'iphone:family',
              eventId: 'phone-row',
              summary: 'Workshop',
              start: '2026-10-22T16:30:00Z',
              end: '2026-10-22T17:30:00Z',
              allDay: false,
              iCalUID: 'shared',
              originalStartTime: '2026-10-22T16:00:00Z',
              ownerParticipation: {
                status: 'accepted',
                identityVerified: true,
                basis: 'attendee-email',
              },
            },
          ],
        }),
      ],
      request: request({ timeZone: 'UTC' }),
    });
    const projected = items(cards);
    expect(projected.map((item) => item.householdDetails)).toEqual([
      expect.objectContaining({
        sources: [
          expect.objectContaining({ rsvp: 'accepted' }),
          expect.objectContaining({ rsvp: 'declined' }),
        ],
      }),
      expect.objectContaining({ sources: [expect.objectContaining({ rsvp: 'accepted' })] }),
    ]);
    const firstDetails = projected[0]?.householdDetails as
      | { sources: Array<{ calendar: string }> }
      | undefined;
    expect(firstDetails?.sources.map((source) => source.calendar)).toEqual(['Work', 'Backup']);
    expect(JSON.stringify(projected[0]?.householdDetails)).not.toContain('google:work');
    const sections = cards.flatMap((card) => card.sections as Array<Record<string, unknown>>);
    const compared = sections.flatMap((section) =>
      Array.isArray(section.items) ? (section.items as Array<Record<string, unknown>>) : [],
    );
    expect(compared).toContainEqual(
      expect.objectContaining({
        comparison: { version: 1, leftEventId: 'work-row', rightEventId: 'phone-row' },
      }),
    );
  });

  it('omits per-source details when source-owned title, start, or all-day facts are missing', () => {
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('merged', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          title: 'Preferred source title',
          sourceVariants: [
            {
              calendar: 'Work',
              summary: 'Work title',
              start: '2026-10-22T16:00:00Z',
              allDay: false,
            },
            { calendar: 'Family', end: '2026-10-22T17:00:00Z' },
          ],
        }),
      ],
      request: request(),
    });
    expect(items(cards)[0]).not.toHaveProperty('householdDetails');
  });

  it('puts named source gaps and actual phone freshness timestamps in coverage', () => {
    const cards = calendarAgendaCards({
      evidence: [
        evidence({
          ok: true,
          complete: true,
          calendarsSearched: ['Work'],
          calendarsResolved: [{ id: 'iphone:family', name: 'Family calendar' }],
          phoneCalendarCoverage: {
            complete: false,
            capturedAt: '2026-10-22T15:00:00Z',
            receivedAt: '2026-10-22T15:05:00Z',
            sources: [{ calendarId: 'family', status: 'permission-denied', complete: false }],
          },
        }),
      ],
      events: [],
      request: request(),
    });
    expect(cards[0]?.householdDay).toMatchObject({
      coverage: {
        complete: false,
        summary: expect.stringContaining('Family calendar: permission denied'),
        freshnessSummary: expect.stringContaining('Phone capture 2026-10-22T15:00:00Z'),
      },
    });
    const freshnessSummary = cards[0]?.householdDay?.coverage.freshnessSummary;
    expect(freshnessSummary).toContain('Assistant received phone snapshot 2026-10-22T15:05:00Z');
  });

  it('keeps accepted driving questions after the 100-detail cap without changing pair counts', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const events = Array.from({ length: 16 }, (_, index) =>
      event(
        `dense-${String(index).padStart(2, '0')}`,
        '2026-10-22T16:00:00Z',
        '2026-10-22T17:00:00Z',
        {
          title: `Commitment ${index}`,
          ...(index < 14 ? { calendarPurpose: 'commitments' } : { ownerParticipation: accepted }),
        },
      ),
    );
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events,
      request: request(),
      requestText: 'Show my agenda. Who will drive?',
    });
    expect(cards[0]?.householdDay).toMatchObject({
      nextQuestion: {
        eventIds: ['dense-14', 'dense-15'],
        remainingIssueCount: 119,
      },
    });
    const denseSections = cards[0]?.sections as Array<Record<string, unknown>> | undefined;
    const conflict = denseSections?.find((section) => typeof section.overlapCount === 'number');
    expect(conflict).toMatchObject({ overlapCount: 120, overlapsTruncated: true });
  });

  it('text fallback ignores unsupported optional versions and questions without unique actual rows', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('left', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
        }),
        event('right', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
      requestText: 'Show my agenda. Who will drive?',
    });
    const card = cards[0];
    if (!card) throw new Error('calendar agenda card was not produced');
    expect(card?.householdDay).toHaveProperty('nextQuestion');
    const validDay = card?.householdDay;
    const unsupportedVersion = {
      ...card,
      householdDay: { ...validDay, version: 2 },
    } as Record<string, unknown>;
    const unsupportedSummary = calendarAgendaSummary([unsupportedVersion]);
    expect(unsupportedSummary).not.toContain('Next question:');

    const sections = (card.sections as Array<Record<string, unknown>>).map((section) => {
      if (section.type !== 'agenda') return section;
      const rows = section.items as Array<Record<string, unknown>>;
      return {
        ...section,
        items: [
          ...rows,
          {
            ...rows[0],
            id: 'left',
            householdDetails: {
              version: 999,
              sources: [{ calendar: 'Fake', title: 'Wrong', start: 'invalid', rsvp: 'accepted' }],
              eventFor: 'someone',
              driving: 'me',
            },
          },
        ],
      };
    });
    const duplicateIds = {
      ...card,
      sections,
      householdDay: validDay,
    } as Record<string, unknown>;
    const duplicateSummary = calendarAgendaSummary([duplicateIds]);
    expect(duplicateSummary).not.toContain('Next question:');
    expect(duplicateSummary).not.toContain('RSVP by source: Fake');
  });

  it('suppresses stale questions when either linked source RSVP is declined or not verified', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('left', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
        }),
        event('right', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
      requestText: 'Show my agenda. Who will drive?',
    });
    const card = cards[0];
    if (!card) throw new Error('calendar agenda card was not produced');
    const makeStaleQuestionCard = (leftRsvp: string, rightRsvp: string) =>
      ({
        ...card,
        sections: (card.sections as Array<Record<string, unknown>>).map((section) => {
          if (section.type !== 'agenda') return section;
          const rows = section.items as Array<Record<string, unknown>>;
          return {
            ...section,
            items: rows.map((row) => {
              const rsvp = row.id === 'left' ? leftRsvp : rightRsvp;
              const details = row.householdDetails as {
                version: 1;
                sources: Array<Record<string, unknown>>;
                eventFor: 'not_stated';
                driving: 'not_stated';
              };
              return {
                ...row,
                householdDetails: {
                  ...details,
                  sources: details.sources.map((source) => ({ ...source, rsvp })),
                },
              };
            }),
          };
        }),
      }) as unknown as Record<string, unknown>;
    for (const statuses of [
      ['declined', 'accepted'],
      ['accepted', 'not_verified'],
      ['declined', 'not_verified'],
    ]) {
      const summary = calendarAgendaSummary([
        makeStaleQuestionCard(statuses[0] ?? '', statuses[1] ?? ''),
      ]);
      expect(summary).not.toContain('Next question:');
    }
  });

  it('does not promote one aggregate accepted RSVP into an unverified source variant', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('aggregate', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
          sourceVariants: [
            {
              calendar: 'Family',
              summary: 'Family event',
              start: '2026-10-22T16:00:00Z',
              end: '2026-10-22T17:00:00Z',
              allDay: false,
              blocksTime: true,
              ownerParticipation: {
                status: 'accepted',
                identityVerified: false,
                basis: 'unverified',
              },
            },
          ],
        }),
        event('accepted', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
      requestText: 'Show my agenda. Who will drive?',
    });
    expect(items(cards)[0]?.householdDetails).toMatchObject({
      sources: [{ calendar: 'Family', rsvp: 'not_verified' }],
    });
    expect(cards[0]?.householdDay).not.toHaveProperty('nextQuestion');

    const declinedCards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('declined-source', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
          sourceVariants: [
            {
              calendar: 'Family',
              summary: 'Family event',
              start: '2026-10-22T16:00:00Z',
              end: '2026-10-22T17:00:00Z',
              allDay: false,
              blocksTime: true,
              ownerParticipation: {
                status: 'declined',
                identityVerified: true,
                basis: 'attendee-email',
              },
            },
          ],
        }),
        event('other', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
      requestText: 'Show my agenda. Who will drive?',
    });
    expect(items(declinedCards)[0]?.householdDetails).toMatchObject({
      sources: [{ calendar: 'Family', rsvp: 'declined' }],
    });
    expect(declinedCards[0]?.householdDay).not.toHaveProperty('nextQuestion');
  });

  it('omits a cross-midnight question when both exact event rows are not on the overlap day card', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('previous-day', '2026-10-22T23:30:00Z', '2026-10-23T00:30:00Z', {
          ownerParticipation: accepted,
        }),
        event('overlap-day', '2026-10-23T00:00:00Z', '2026-10-23T00:45:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request({ timeZone: 'UTC' }),
      requestText: 'Show my agenda. Who will drive?',
    });
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => !card.householdDay?.nextQuestion)).toBe(true);
    expect(calendarAgendaSummary(cards as Array<Record<string, unknown>>)).not.toContain(
      'Next question:',
    );
  });

  it('selects the earliest owner-relevant accepted overlap, breaks ties by IDs, and omits unknown family prompts', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const pair = [
      event('one', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
        ownerParticipation: accepted,
      }),
      event('two', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
        ownerParticipation: accepted,
      }),
    ];
    const ownerQuestion = 'Show my agenda. Who will drive?';
    const oneIssue = calendarAgendaCards({
      evidence: [evidence()],
      events: pair,
      request: request(),
      requestText: ownerQuestion,
    });
    expect(oneIssue[0]?.householdDay).toMatchObject({
      nextQuestion: { eventIds: ['one', 'two'], remainingIssueCount: 0 },
    });

    const tied = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('c', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
        }),
        event('b', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
        }),
        event('a', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          ownerParticipation: accepted,
        }),
      ],
      request: request(),
      requestText: ownerQuestion,
    });
    expect(tied[0]?.householdDay).toMatchObject({
      nextQuestion: { eventIds: ['a', 'b'], remainingIssueCount: 2 },
    });

    const familyContextOnly = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('family-a', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z', {
          calendar: 'Family',
          calendarPurpose: 'family',
        }),
        event('family-b', '2026-10-22T16:30:00Z', '2026-10-22T17:30:00Z', {
          calendar: 'Family',
          calendarPurpose: 'family',
        }),
      ],
      request: request(),
      requestText: ownerQuestion,
    });
    expect(familyContextOnly[0]?.householdDay).not.toHaveProperty('nextQuestion');
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
    expect(cards[0]?.lead).toContain('No events returned from Work');
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
          'overnight (Calendar) · overlap (Calendar). Your attendance at overnight (Calendar) and overlap (Calendar) isn’t confirmed.',
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
      'Your attendance at unknown-1 (Calendar) and unknown-2 (Calendar) isn’t confirmed.',
    );
  });

  it('names verified and unconfirmed attendance per event without choosing a disputed source status', () => {
    const accepted = { status: 'accepted', identityVerified: true, basis: 'attendee-email' };
    const tentative = { status: 'tentative', identityVerified: true, basis: 'attendee-email' };
    const cards = calendarAgendaCards({
      evidence: [evidence()],
      events: [
        event('team-planning', '2026-10-22T09:00:00Z', '2026-10-22T10:00:00Z', {
          title: 'Planning',
          calendar: 'Team',
          ownerParticipation: accepted,
        }),
        event('family-planning', '2026-10-22T09:30:00Z', '2026-10-22T10:30:00Z', {
          title: 'Planning',
          calendar: 'Family',
          calendarPurpose: 'commitments',
          sourceVariants: [
            { calendar: 'Family', blocksTime: true, ownerParticipation: accepted },
            { calendar: 'Family copy', blocksTime: true, ownerParticipation: tentative },
          ],
        }),
      ],
      request: request({ timeZone: 'UTC' }),
    });
    const overlap = ((cards[0]?.sections ?? []) as Array<Record<string, unknown>>).find(
      (section) => section.overlaps,
    );

    expect(JSON.stringify(overlap?.overlaps)).toContain(
      'Your calendar settings mark these as commitments. You accepted Planning (Team). Your attendance at Planning (Family, Family copy) isn’t confirmed.',
    );
    expect(JSON.stringify(overlap?.overlaps)).not.toContain('You accepted both invitations');
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
      { title: 'Calendar source differences' },
      { title: 'Calendar read coverage' },
    ]);
    expect(JSON.stringify(sections)).not.toContain('differ in time zone, time');
  });

  it('does not claim same-time meetings across zones without valid intervals and zones', () => {
    const invalidSources: Record<string, unknown>[] = [
      {
        calendarId: 'family',
        eventId: 'copy',
        end: '2026-10-22T19:00:00-07:00',
        allDay: false,
        calendarTimeZone: 'America/Los_Angeles',
      },
      {
        calendarId: 'family',
        eventId: 'copy',
        start: '2026-10-22',
        end: '2026-10-23',
        allDay: false,
        calendarTimeZone: 'America/Los_Angeles',
      },
      {
        calendarId: 'family',
        eventId: 'copy',
        start: '2026-10-22T18:00:00-07:00',
        end: '2026-10-22T19:00:00-07:00',
        allDay: false,
        calendarTimeZone: 'Mars/Olympus',
      },
    ];

    for (const source of invalidSources) {
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
              source,
            ],
          }),
        ],
        request: request(),
      });

      expect(JSON.stringify(cards[0]?.sections)).not.toContain(
        'same meeting time in different calendar time zones',
      );
    }
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
