import { describe, expect, it, vi } from 'vitest';
import {
  calendarEventAnalysisResponse,
  requestedCalendarEventAnalysis,
} from './calendar-event-analysis.js';
import * as calendarRelationship from './calendar-relationship.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from './read-intent.js';
import { verifiedReadResponse } from './response-contract.js';

const prompt =
  'Review my calendar for the next two weekdays in my calendar’s timezone. For each day, count events lasting at least 45 minutes. Also report gaps of 30 minutes or more between events explicitly marked in person, including the event times and locations when available. Do not infer travel time, event mode, or missing times; link to the source events if the calendar provides links. This is read-only; do not change anything.';

const options = { now: new Date('2026-10-30T16:00:00.000Z'), timeZone: 'America/Los_Angeles' };

function event(input: Partial<Record<string, unknown>> & Record<string, unknown>) {
  return {
    calendarId: 'primary',
    eventId: 'event',
    summary: 'Planning meeting',
    start: '2026-11-02T17:00:00.000Z',
    end: '2026-11-02T17:45:00.000Z',
    ...input,
  };
}

describe('calendar weekday event analysis', () => {
  it('analyzes the 150-listing boundary and fails closed before grouping larger results', () => {
    const events = Array.from({ length: 150 }, (_, index) =>
      event({
        calendarId: `calendar-${index}@example.test`,
        eventId: `event-${index}`,
        summary: `Returned event ${index}`,
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T18:00:00.000Z',
      }),
    );
    const groupingSpy = vi.spyOn(calendarRelationship, 'canonicalOccurrenceGroups');
    try {
      const boundary = calendarEventAnalysisResponse({
        request: { weekdayCount: 1, minimumDurationMinutes: 45, durationCountMode: 'events' },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        events,
        coverageComplete: true,
      });
      expect(boundary).toContain('150 qualifying events.');
      expect(groupingSpy).toHaveBeenCalledTimes(1);

      groupingSpy.mockClear();
      const overflow = calendarEventAnalysisResponse({
        request: { weekdayCount: 1, minimumDurationMinutes: 45, durationCountMode: 'events' },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        events: [...events, event({ calendarId: 'overflow', eventId: 'overflow' })],
        coverageComplete: true,
      });
      expect(overflow).toContain('Too many calendar listings were returned');
      expect(overflow).toContain('Narrow the date window');
      expect(overflow).not.toContain('151 qualifying events');
      expect(groupingSpy).not.toHaveBeenCalled();

      const incompleteOverflow = calendarEventAnalysisResponse({
        request: { weekdayCount: 1, minimumDurationMinutes: 45, durationCountMode: 'events' },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        events: [...events, event({ calendarId: 'overflow', eventId: 'overflow' })],
        coverageComplete: false,
      });
      expect(incompleteOverflow).toContain('Calendar coverage was incomplete');
      expect(groupingSpy).not.toHaveBeenCalled();

      const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], options);
      if (!request) throw new Error('The calendar analysis request must resolve');
      const ledgerOverflow = verifiedReadResponse(request, [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: buildReadToolInput(request, 'calendar.list_events', []),
          result: {
            events: [...events, event({ calendarId: 'overflow', eventId: 'overflow' })],
            calendarsSearched: ['Work'],
            calendarRosterComplete: true,
            unavailable: [],
            complete: true,
          },
        },
      ]);
      expect(ledgerOverflow).toContain('Too many calendar listings were returned');
      expect(ledgerOverflow).not.toContain('qualifying events');
      expect(ledgerOverflow).not.toContain('minutes,');
      expect(groupingSpy).not.toHaveBeenCalled();
    } finally {
      groupingSpy.mockRestore();
    }
  });

  it('routes the bounded request to a read-only event list in the owner timezone across DST', () => {
    const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], options);
    expect(request).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
      queryTerms: [],
      maxResults: 50,
      calendarEventAnalysis: {
        weekdayCount: 2,
        minimumDurationMinutes: 45,
        minimumInPersonGapMinutes: 30,
      },
      timeZone: 'America/Los_Angeles',
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-04T08:00:00.000Z',
        label: 'the next 2 weekdays',
      },
    });
    expect(request?.weeklyCalendarPlan).toBeUndefined();
    expect(request?.temporalIssue).toBeUndefined();
    expect(request?.firstToolName).not.toContain('create');

    const focusPlan = detectPersonalReadRequest(
      [
        {
          role: 'user',
          content: 'Review my calendar next week and find three 90-minute focus blocks.',
        },
      ],
      options,
    );
    expect(focusPlan?.weeklyCalendarPlan).toBe(true);
    expect(focusPlan?.calendarEventAnalysis).toBeUndefined();
  });

  it('starts after today, skips weekends, and crosses month boundaries in the configured zone', () => {
    const saturday = detectPersonalReadRequest([{ role: 'user', content: prompt }], {
      now: new Date('2026-10-31T19:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(saturday?.timeWindow).toMatchObject({
      timeMin: '2026-11-02T08:00:00.000Z',
      timeMax: '2026-11-04T08:00:00.000Z',
    });

    const monthEnd = detectPersonalReadRequest(
      [{ role: 'user', content: prompt.replace('two weekdays', 'two weekdays') }],
      { now: new Date('2026-11-30T17:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(monthEnd?.timeWindow).toMatchObject({
      timeMin: '2026-12-01T08:00:00.000Z',
      timeMax: '2026-12-03T08:00:00.000Z',
    });
  });

  it('does not reinterpret ordinary focus planning or unsupported oversized weekday windows', () => {
    expect(
      requestedCalendarEventAnalysis(
        'For my calendar, over the next 3 weekdays, count events lasting at least 45 minutes and find gaps of at least 30 minutes between events explicitly marked in person.',
      ),
    ).toMatchObject({
      weekdayCount: 3,
      minimumDurationMinutes: 45,
      durationCountMode: 'events',
      minimumInPersonGapMinutes: 30,
    });
    expect(
      requestedCalendarEventAnalysis(
        'For my calendar, over the next two weekdays, how many days have an event lasting at least 45 minutes?',
      ),
    ).toMatchObject({
      weekdayCount: 2,
      minimumDurationMinutes: 45,
      durationCountMode: 'days',
    });
    expect(
      requestedCalendarEventAnalysis(
        'For my calendar, over the next 3 weekdays, what is the number of days with one or more appointments lasting 60 minutes?',
      ),
    ).toMatchObject({ durationCountMode: 'days' });
    expect(
      requestedCalendarEventAnalysis(
        'Review my calendar next two weekdays for a 90-minute focus block.',
      ),
    ).toBeUndefined();
    expect(
      requestedCalendarEventAnalysis(
        'Review my calendar for the next 11 weekdays and count events lasting at least 45 minutes.',
      ),
    ).toBeUndefined();

    const mixedReadAndWrite = detectPersonalReadRequest(
      [
        {
          role: 'user',
          content: `${prompt} Then move the first event to Friday.`,
        },
      ],
      options,
    );
    expect(mixedReadAndWrite?.calendarEventAnalysis).toBeUndefined();
  });

  it('calculates overlap-duration counts, skips cancelled events and duplicate IDs, and uses source links', () => {
    const text = calendarEventAnalysisResponse({
      request: {
        weekdayCount: 2,
        minimumDurationMinutes: 45,
      },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-04T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        event({
          eventId: 'exact-45',
          summary: 'Exactly 45 minutes',
          start: '2026-11-02T17:00:00.000Z',
          end: '2026-11-02T17:45:00.000Z',
          links: [
            { label: 'Hotel management', url: 'https://hotel.example/manage?token=booking-secret' },
            {
              label: 'Open event',
              url: 'https://calendar.google.com/event?eid=exact-45&access_token=query-secret#token=fragment-secret',
            },
          ],
        }),
        event({
          eventId: 'short',
          summary: 'Short meeting',
          start: '2026-11-02T18:00:00.000Z',
          end: '2026-11-02T18:44:00.000Z',
        }),
        event({
          eventId: 'clipped-overnight',
          summary: 'Overnight appointment',
          start: '2026-11-02T07:30:00.000Z',
          end: '2026-11-02T09:00:00.000Z',
        }),
        event({
          eventId: 'cancelled',
          status: 'cancelled',
          start: '2026-11-02T19:00:00.000Z',
          end: '2026-11-02T20:00:00.000Z',
        }),
        event({
          eventId: 'multiday',
          summary: 'Overnight event',
          start: '2026-11-04T07:30:00.000Z',
          end: '2026-11-04T09:00:00.000Z',
        }),
        event({
          eventId: 'multiday',
          summary: 'Duplicate overnight event',
          start: '2026-11-04T07:30:00.000Z',
          end: '2026-11-04T09:00:00.000Z',
        }),
      ],
    });
    expect(text).toContain('Monday, Nov 2, 2026: 2 qualifying events.');
    expect(text).toContain('Tuesday, Nov 3, 2026: 1 qualifying event.');
    expect(text).toContain(
      'Overnight appointment (Sunday, Nov 1, 2026 11:30 PM–Monday, Nov 2, 2026 1:00 AM)',
    );
    expect(text).toContain('[Open event](https://calendar.google.com/event?eid=exact-45)');
    expect(text).not.toContain('hotel.example');
    expect(text).not.toContain('booking-secret');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('fragment-secret');
    expect(text).not.toContain('Short meeting');
    expect(text).not.toContain('Cancelled');
    expect(text).toContain('Duplicate overnight event');
    expect(text).toContain('Source titles differ.');
  });

  it('counts strict cross-calendar copies once without merging unrelated or probable copies', () => {
    const canonical = event({
      calendarId: 'work@example.test',
      eventId: 'work-copy',
      calendar: 'Work',
      iCalUID: 'shared-uid@example.test',
      originalStartTime: '2026-11-02T09:00:00-08:00',
      start: '2026-11-02T17:00:00.000Z',
      end: '2026-11-02T18:00:00.000Z',
      links: [{ label: 'Open Work event', url: 'https://calendar.google.com/event?eid=work-copy' }],
    });
    const exactCrossCalendarCopy = {
      ...canonical,
      calendarId: 'personal@example.test',
      eventId: 'personal-copy',
      originalStartTime: '2026-11-02T17:00:00Z',
      calendar: 'Personal',
      links: [
        {
          label: 'Open Personal event',
          url: 'https://calendar.google.com/event?eid=personal-copy',
        },
      ],
    };
    const analysis = (events: Record<string, unknown>[], coverageComplete = true) =>
      calendarEventAnalysisResponse({
        request: { weekdayCount: 1, minimumDurationMinutes: 45, durationCountMode: 'events' },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        events,
        coverageComplete,
      });

    const distinctAccepted = analysis([
      {
        ...canonical,
        eventId: 'accepted-work',
        ownerParticipation: { status: 'accepted', identityVerified: true, basis: 'attendee-email' },
      },
      {
        ...canonical,
        calendarId: 'personal@example.test',
        eventId: 'accepted-personal',
        iCalUID: 'another-uid@example.test',
        ownerParticipation: { status: 'accepted', identityVerified: true, basis: 'attendee-email' },
      },
    ]);
    expect(distinctAccepted).toContain('Monday, Nov 2, 2026: 2 qualifying events.');

    const unknownAttendanceLookalikes = analysis([
      {
        ...canonical,
        iCalUID: undefined,
        originalStartTime: undefined,
        ownerParticipation: { status: 'unknown', identityVerified: false, basis: 'unverified' },
      },
      {
        ...canonical,
        calendarId: 'iphone:family',
        eventId: 'phone-lookalike',
        iCalUID: undefined,
        originalStartTime: undefined,
        ownerParticipation: { status: 'unknown', identityVerified: false, basis: 'unverified' },
      },
    ]);
    expect(unknownAttendanceLookalikes).toContain('Monday, Nov 2, 2026: 2 qualifying events.');

    for (const missingOrInvalid of [
      [undefined, undefined],
      ['not-a-date', 'not-a-date'],
      ['2026-11-02T17:00:00Z', undefined],
      [undefined, '2026-11-02T17:00:00Z'],
    ]) {
      const occurrenceMetadata = analysis([
        {
          ...canonical,
          eventId: 'eventkit-reused-id',
          recurringEventId: 'weekly-series',
          originalStartTime: missingOrInvalid[0],
        },
        {
          ...canonical,
          eventId: 'eventkit-reused-id',
          recurringEventId: 'weekly-series',
          originalStartTime: missingOrInvalid[1],
        },
      ]);
      expect(occurrenceMetadata).toContain(
        'Monday, Nov 2, 2026: at least 2 qualifying returned listings; unique occurrence count unresolved.',
      );
      expect(occurrenceMetadata).toContain('unique occurrence count unresolved');
    }

    const differentRecurrenceInstances = analysis([
      {
        ...canonical,
        recurringEventId: 'weekly-series',
        originalStartTime: '2026-10-26T17:00:00Z',
      },
      {
        ...canonical,
        calendarId: 'personal@example.test',
        eventId: 'next-week',
        recurringEventId: 'weekly-series',
        originalStartTime: '2026-11-02T17:00:00Z',
      },
    ]);
    expect(differentRecurrenceInstances).toContain('Monday, Nov 2, 2026: 2 qualifying events.');

    const reusedSameCalendarID = analysis([
      {
        ...canonical,
        eventId: 'eventkit-reused-id',
        recurringEventId: 'weekly-series',
        originalStartTime: '2026-10-26T17:00:00Z',
      },
      {
        ...canonical,
        eventId: 'eventkit-reused-id',
        recurringEventId: 'weekly-series',
        originalStartTime: '2026-11-02T17:00:00Z',
      },
    ]);
    expect(reusedSameCalendarID).toContain('Monday, Nov 2, 2026: 2 qualifying events.');

    const multidayRecurringEvent = calendarEventAnalysisResponse({
      request: { weekdayCount: 2, minimumDurationMinutes: 45, durationCountMode: 'events' },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-04T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        {
          ...canonical,
          eventId: 'eventkit-weekly-id',
          recurringEventId: 'weekly-series',
          originalStartTime: '2026-10-26T17:00:00Z',
          start: '2026-11-02T17:00:00.000Z',
          end: '2026-11-02T18:00:00.000Z',
        },
        {
          ...canonical,
          eventId: 'eventkit-weekly-id',
          recurringEventId: 'weekly-series',
          originalStartTime: '2026-11-02T17:00:00Z',
          start: '2026-11-03T17:00:00.000Z',
          end: '2026-11-03T18:00:00.000Z',
        },
      ],
    });
    expect(multidayRecurringEvent).toContain('Monday, Nov 2, 2026: 1 qualifying event.');
    expect(multidayRecurringEvent).toContain('Tuesday, Nov 3, 2026: 1 qualifying event.');

    const crossCalendarCopyText = analysis([canonical, exactCrossCalendarCopy]);
    expect(crossCalendarCopyText).toContain('configured owner time zone (America/Los_Angeles)');
    expect(crossCalendarCopyText).toContain('Monday, Nov 2, 2026: 1 qualifying event.');
    expect(crossCalendarCopyText).toContain(
      '[Open Work event](https://calendar.google.com/event?eid=work-copy)',
    );
    expect(crossCalendarCopyText).toContain(
      '[Open Personal event](https://calendar.google.com/event?eid=personal-copy)',
    );
    expect(crossCalendarCopyText).not.toContain('coverage was incomplete');

    const partialCoverageCopyText = analysis([canonical, exactCrossCalendarCopy], false);
    expect(partialCoverageCopyText).toContain('at least 1 qualifying event in the checked subset');
    expect(partialCoverageCopyText).toContain('coverage was incomplete');

    const differingBounds = analysis([
      canonical,
      {
        ...exactCrossCalendarCopy,
        start: '2026-11-02T17:30:00.000Z',
        end: '2026-11-02T18:30:00.000Z',
      },
    ]);
    expect(differingBounds).toContain('at least 0 qualifying events in the checked subset');
    expect(differingBounds).toContain('Source times disagree.');
    expect(differingBounds).toContain('Work');
    expect(differingBounds).toContain('Personal');
    expect(differingBounds).toContain(
      '[Open Work event](https://calendar.google.com/event?eid=work-copy)',
    );
    expect(differingBounds).toContain(
      '[Open Personal event](https://calendar.google.com/event?eid=personal-copy)',
    );

    const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], options);
    const toolArgs = buildReadToolInput(
      request as NonNullable<typeof request>,
      'calendar.list_events',
      [],
    );
    const reusedEventKitID = verifiedReadResponse(
      request as NonNullable<typeof request>,
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: toolArgs,
          result: {
            events: [
              {
                ...canonical,
                eventId: 'eventkit-reused-id',
                recurringEventId: 'weekly-series',
                originalStartTime: '2026-10-26T17:00:00Z',
              },
              {
                ...canonical,
                eventId: 'eventkit-reused-id',
                recurringEventId: 'weekly-series',
                originalStartTime: '2026-11-02T17:00:00Z',
              },
            ],
            calendarsSearched: ['Work'],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ] as never,
    );
    expect(reusedEventKitID).toContain('Monday, Nov 2, 2026: 2 qualifying events.');
    expect(reusedEventKitID).toContain('configured owner time zone (America/Los_Angeles)');
    expect(reusedEventKitID).not.toContain('coverage was incomplete');
  });

  it('does not claim free in-person gaps through unresolved calendar time', () => {
    const gapAnalysis = (events: Record<string, unknown>[]) =>
      calendarEventAnalysisResponse({
        request: {
          weekdayCount: 1,
          minimumDurationMinutes: 45,
          durationCountMode: 'events',
          minimumInPersonGapMinutes: 30,
        },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        events,
        coverageComplete: true,
      });
    const inPerson = (input: Record<string, unknown>) =>
      event({ ...input, eventMode: 'in-person' });
    const prior = inPerson({
      calendarId: 'work@example.test',
      eventId: 'prior',
      summary: 'Earlier in-person meeting',
      start: '2026-11-02T16:00:00.000Z',
      end: '2026-11-02T16:30:00.000Z',
    });
    const later = inPerson({
      calendarId: 'work@example.test',
      eventId: 'later',
      summary: 'Later in-person meeting',
      start: '2026-11-02T19:30:00.000Z',
      end: '2026-11-02T20:00:00.000Z',
    });
    const ambiguousCopy = [
      event({
        calendarId: 'work@example.test',
        eventId: 'copy-a',
        calendar: 'Work',
        status: 'confirmed',
        eventMode: 'in-person',
        location: 'Main Hall',
        iCalUID: 'ambiguous-copy@example.test',
        originalStartTime: '2026-11-02T17:00:00.000Z',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T18:00:00.000Z',
        links: [{ label: 'Open Work event', url: 'https://calendar.google.com/event?eid=copy-a' }],
      }),
      event({
        calendarId: 'personal@example.test',
        eventId: 'copy-b',
        calendar: 'Personal',
        status: 'cancelled',
        eventMode: 'virtual',
        location: 'Video call',
        iCalUID: 'ambiguous-copy@example.test',
        originalStartTime: '2026-11-02T17:00:00Z',
        start: '2026-11-02T18:30:00.000Z',
        end: '2026-11-02T19:30:00.000Z',
        links: [
          { label: 'Open Personal event', url: 'https://calendar.google.com/event?eid=copy-b' },
        ],
      }),
    ];
    const [copyA, copyB] = ambiguousCopy;
    if (!copyA || !copyB) throw new Error('Expected both calendar source variants.');
    const ambiguousText = gapAnalysis([prior, ...ambiguousCopy, later]);
    expect(ambiguousText).not.toContain('- 30 minutes,');
    expect(ambiguousText).not.toContain('180 minutes, 8:30 AM–11:30 AM');
    expect(ambiguousText).toContain('Source times disagree.');
    expect(ambiguousText).toContain('Source status differs.');
    expect(ambiguousText).toContain('Attendance mode differs by source.');
    expect(ambiguousText).toContain('Location differs by source.');
    expect(ambiguousText).toContain('9:00 AM–10:00 AM');
    expect(ambiguousText).toContain('10:30 AM–11:30 AM');
    expect(ambiguousText).toContain('Open Work event');
    expect(ambiguousText).toContain('Open Personal event');
    const analysisSurface = (value: string) =>
      value
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('- Monday, Nov 2, 2026:') ||
            line.startsWith('- 2026-11-02:') ||
            line.startsWith('- No positive gap') ||
            line.startsWith('- No qualifying gap'),
        );
    for (const order of [
      [later, copyB, prior, copyA],
      [copyB, prior, copyA, later],
      [copyA, later, copyB, prior],
    ]) {
      expect(analysisSurface(gapAnalysis(order))).toEqual(analysisSurface(ambiguousText));
    }

    const unknownPlacement = gapAnalysis([
      prior,
      event({
        calendarId: 'work@example.test',
        eventId: 'unknown-placement',
        summary: 'Event with an unknown time',
        start: '',
        end: '',
      }),
      later,
    ]);
    expect(unknownPlacement).not.toMatch(/- \d+ minutes,/);
    expect(unknownPlacement).toContain('missing, all-day, or invalid start/end times');
  });

  it('keeps missing-time results as a lower bound rather than guessing a duration', () => {
    const text = calendarEventAnalysisResponse({
      request: {
        weekdayCount: 2,
        minimumDurationMinutes: 45,
        durationCountMode: 'days',
      },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-04T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        event({ eventId: 'unknown', summary: 'No returned end', end: '' }),
        event({
          eventId: 'all-day',
          summary: 'All day item',
          start: '2026-11-02',
          end: '2026-11-03',
        }),
      ],
    });
    expect(text).toContain('at least 0 qualifying events in the checked subset');
    expect(text).toContain(
      'Days with at least one event lasting 45 minutes: at least 0 in the checked subset of 2 requested weekdays.',
    );
    expect(text).toContain(
      '2 event(s) with missing, all-day, or invalid start/end times were excluded',
    );
    expect(text).not.toContain('0 qualifying events.');
  });

  it('does not count an unresolved cancellation or duration disagreement as a qualifying day', () => {
    const analyzeDays = (events: Record<string, unknown>[]) =>
      calendarEventAnalysisResponse({
        request: {
          weekdayCount: 1,
          minimumDurationMinutes: 45,
          durationCountMode: 'days',
        },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        coverageComplete: true,
        events,
      });
    const conflict = [
      event({
        calendarId: 'work@example.test',
        eventId: 'shared-event',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-11-02T17:00:00.000Z',
        status: 'cancelled',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:45:00.000Z',
      }),
      event({
        calendarId: 'work@example.test',
        eventId: 'shared-event',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-11-02T17:00:00Z',
        status: 'confirmed',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:20:00.000Z',
      }),
    ];
    const conflictedOnly = analyzeDays(conflict);
    expect(conflictedOnly).toContain(
      'Days with at least one event lasting 45 minutes: at least 0 in the checked subset of 1 requested weekdays.',
    );
    expect(conflictedOnly).not.toContain(
      'at least 1 in the checked subset of 1 requested weekdays',
    );

    const sameStatusConflict = [
      event({
        calendarId: 'work@example.test',
        eventId: 'same-status-event',
        iCalUID: 'same-status-event@example.test',
        originalStartTime: '2026-11-02T17:00:00.000Z',
        status: 'confirmed',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T18:00:00.000Z',
      }),
      event({
        calendarId: 'work@example.test',
        eventId: 'same-status-event',
        iCalUID: 'same-status-event@example.test',
        originalStartTime: '2026-11-02T17:00:00Z',
        status: 'confirmed',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:30:00.000Z',
      }),
    ];
    const sameStatusDurationConflict = analyzeDays(sameStatusConflict);
    expect(sameStatusDurationConflict).toContain(
      'Days with at least one event lasting 45 minutes: at least 0 in the checked subset of 1 requested weekdays.',
    );
    expect(sameStatusDurationConflict).not.toContain(
      'at least 1 in the checked subset of 1 requested weekdays',
    );

    const knownMatch = event({
      eventId: 'known-match',
      summary: 'Confirmed separate event',
      start: '2026-11-02T19:00:00.000Z',
      end: '2026-11-02T19:45:00.000Z',
    });
    expect(analyzeDays([...conflict, ...sameStatusConflict, knownMatch])).toContain(
      'Days with at least one event lasting 45 minutes: at least 1 in the checked subset of 1 requested weekdays.',
    );
  });

  it('keeps asymmetric occurrence metadata and non-clique identity bridges unresolved in any input order', () => {
    const analyze = (events: Record<string, unknown>[]) =>
      calendarEventAnalysisResponse({
        request: {
          weekdayCount: 1,
          minimumDurationMinutes: 30,
          durationCountMode: 'events',
          minimumInPersonGapMinutes: 30,
        },
        timeWindow: {
          timeMin: '2026-11-02T08:00:00.000Z',
          timeMax: '2026-11-03T08:00:00.000Z',
        },
        timeZone: 'America/Los_Angeles',
        coverageComplete: true,
        events,
      });
    const asymmetric = [
      event({
        calendarId: 'work@example.test',
        eventId: 'work-copy',
        iCalUID: 'asymmetric@example.test',
        originalStartTime: '2026-11-02T17:00:00.000Z',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:30:00.000Z',
      }),
      event({
        calendarId: 'personal@example.test',
        eventId: 'personal-copy',
        iCalUID: 'asymmetric@example.test',
        originalStartTime: undefined,
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:30:00.000Z',
      }),
    ];
    const asymmetricForward = analyze(asymmetric);
    const asymmetricReverse = analyze([...asymmetric].reverse());
    for (const output of [asymmetricForward, asymmetricReverse]) {
      expect(output).toContain(
        'at least 2 qualifying returned listings; unique occurrence count unresolved.',
      );
      expect(output).not.toContain('2 qualifying events.');
    }

    const bridge = [
      event({
        calendarId: 'work@example.test',
        eventId: 'work-a',
        summary: 'First in-person meeting',
        eventMode: 'in-person',
        iCalUID: 'bridge@example.test',
        originalStartTime: '2026-11-02T17:00:00Z',
        start: '2026-11-02T16:00:00.000Z',
        end: '2026-11-02T16:30:00.000Z',
      }),
      event({
        calendarId: 'personal@example.test',
        eventId: 'personal-b',
        summary: 'Second in-person meeting',
        eventMode: 'in-person',
        iCalUID: 'bridge@example.test',
        originalStartTime: '2026-11-02T17:00:00.000Z',
        start: '2026-11-02T17:00:00.000Z',
        end: '2026-11-02T17:30:00.000Z',
      }),
      event({
        calendarId: 'work@example.test',
        eventId: 'work-c',
        summary: 'Third in-person meeting',
        eventMode: 'in-person',
        iCalUID: 'bridge@example.test',
        originalStartTime: '2026-11-02T17:00:00Z',
        start: '2026-11-02T19:00:00.000Z',
        end: '2026-11-02T19:30:00.000Z',
      }),
    ];
    const bridgeForward = analyze(bridge);
    const bridgeReverse = analyze([...bridge].reverse());
    for (const output of [bridgeForward, bridgeReverse]) {
      expect(output).toContain(
        'at least 3 qualifying returned listings; unique occurrence count unresolved.',
      );
      expect(output).not.toContain('3 qualifying events.');
      expect(output).not.toContain('- 30 minutes,');
      expect(output).not.toContain('- 90 minutes,');
    }
  });

  it('counts qualifying weekdays separately from qualifying events', () => {
    const text = calendarEventAnalysisResponse({
      request: {
        weekdayCount: 3,
        minimumDurationMinutes: 45,
        durationCountMode: 'days',
      },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-05T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        event({
          eventId: 'monday-a',
          summary: 'Monday planning',
          start: '2026-11-02T17:00:00.000Z',
          end: '2026-11-02T17:45:00.000Z',
        }),
        event({
          eventId: 'monday-b',
          summary: 'Monday review',
          start: '2026-11-02T18:00:00.000Z',
          end: '2026-11-02T18:45:00.000Z',
        }),
        event({
          eventId: 'tuesday-a',
          summary: 'Tuesday planning',
          start: '2026-11-03T17:00:00.000Z',
          end: '2026-11-03T17:45:00.000Z',
        }),
      ],
    });
    expect(text).toContain(
      'Days with at least one event lasting 45 minutes: 2 of 3 requested weekdays.',
    );
    expect(text).toContain('Monday, Nov 2, 2026: 2 qualifying events.');
    expect(text).toContain('Tuesday, Nov 3, 2026: 1 qualifying event.');
    expect(text).toContain('Wednesday, Nov 4, 2026: 0 qualifying events.');
  });

  it('reports only explicit in-person gaps and never infers mode from an address', () => {
    const text = calendarEventAnalysisResponse({
      request: { weekdayCount: 2, minimumInPersonGapMinutes: 30 },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-04T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        event({
          eventId: 'onsite-a',
          summary: 'Marked in-person: Design review',
          description: 'Attendance mode: in person',
          location: '100 Main Street',
          start: '2026-11-02T17:00:00.000Z',
          end: '2026-11-02T17:30:00.000Z',
        }),
        event({
          eventId: 'unknown-mode',
          summary: 'Address only',
          location: 'Office, 100 Main Street',
          start: '2026-11-03T17:45:00.000Z',
          end: '2026-11-03T18:00:00.000Z',
        }),
        event({
          eventId: 'onsite-b',
          summary: 'Marked in person: Customer visit',
          description: 'Format: in-person',
          location: '200 Oak Street',
          start: '2026-11-02T18:00:00.000Z',
          end: '2026-11-02T18:30:00.000Z',
        }),
        event({
          eventId: 'negative-mode',
          summary: 'Remote planning',
          description: 'This is not an in-person meeting.',
          location: 'Video room',
          start: '2026-11-03T17:00:00.000Z',
          end: '2026-11-03T18:00:00.000Z',
        }),
      ],
    });
    expect(text).toContain('30 minutes, 9:30 AM–10:00 AM');
    expect(text).toContain(
      'between Marked in\\-person: Design review at 100 Main Street and Marked in person: Customer visit at 200 Oak Street',
    );
    expect(text).not.toContain('between Address only and');
    expect(text).toContain('A location alone was not treated as evidence');
  });

  it('does not report free gaps while an overlapping event is still in progress', () => {
    const text = calendarEventAnalysisResponse({
      request: { weekdayCount: 1, minimumInPersonGapMinutes: 30 },
      timeWindow: {
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-03T08:00:00.000Z',
      },
      timeZone: 'America/Los_Angeles',
      coverageComplete: true,
      events: [
        event({
          eventId: 'long',
          summary: 'Long meeting',
          description: 'Attendance mode: in person',
          start: '2026-11-02T17:00:00.000Z',
          end: '2026-11-02T20:00:00.000Z',
        }),
        event({
          eventId: 'nested-a',
          summary: 'Nested review',
          description: 'Attendance mode: in person',
          start: '2026-11-02T17:30:00.000Z',
          end: '2026-11-02T18:00:00.000Z',
        }),
        event({
          eventId: 'nested-b',
          summary: 'Nested follow-up',
          description: 'Attendance mode: in person',
          start: '2026-11-02T18:30:00.000Z',
          end: '2026-11-02T19:00:00.000Z',
        }),
      ],
    });
    expect(text).toContain('No qualifying gaps were found');
    expect(text).not.toMatch(/- 2026-11-02: \d+ minutes,/);
  });

  it('paginates the bounded list and reports checked-subset counts when coverage is incomplete', () => {
    const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], options);
    expect(request).not.toBeNull();
    const firstInput = buildReadToolInput(
      request as NonNullable<typeof request>,
      'calendar.list_events',
      [],
    );
    expect(firstInput).toMatchObject({
      timeMin: '2026-11-02T08:00:00.000Z',
      timeMax: '2026-11-04T08:00:00.000Z',
      maxResults: 50,
    });
    expect(firstInput).not.toHaveProperty('calendarIds');
    expect(firstInput).not.toHaveProperty('pageToken');

    const pageOne: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: { ...firstInput },
      result: {
        events: [
          event({
            eventId: 'one',
            start: '2026-11-02T17:00:00.000Z',
            end: '2026-11-02T18:00:00.000Z',
          }),
        ],
        calendarsSearched: ['Primary'],
        complete: false,
        calendarRosterComplete: true,
        unavailable: [],
        nextPageToken: 'cursor-2',
      },
    };
    expect(nextRequiredReadTool(request as NonNullable<typeof request>, [pageOne])).toBe(
      'calendar.list_events',
    );
    const secondInput = buildReadToolInput(
      request as NonNullable<typeof request>,
      'calendar.list_events',
      [pageOne],
    );
    expect(secondInput?.pageToken).toBe('cursor-2');
    expect(secondInput?.timeMin).toBe(firstInput?.timeMin);
    expect(secondInput?.timeMax).toBe(firstInput?.timeMax);

    const pageTwo: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: { ...secondInput },
      result: {
        events: [],
        calendarsSearched: ['Primary'],
        complete: true,
        calendarRosterComplete: true,
        unavailable: [],
      },
    };
    expect(nextRequiredReadTool(request as NonNullable<typeof request>, [pageOne, pageTwo])).toBe(
      undefined,
    );
    const response = verifiedReadResponse(
      request as NonNullable<typeof request>,
      [pageOne, pageTwo] as never,
    );
    expect(response).toContain('Monday, Nov 2, 2026: 1 qualifying event.');
    expect(response).not.toContain('coverage was incomplete');

    const partial = verifiedReadResponse(
      request as NonNullable<typeof request>,
      [pageOne] as never,
    );
    expect(partial).toContain('at least 1 qualifying event in the checked subset');
    expect(partial).toContain('coverage was incomplete');
  });
});
