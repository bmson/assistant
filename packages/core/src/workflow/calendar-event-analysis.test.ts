import { describe, expect, it } from 'vitest';
import {
  calendarEventAnalysisResponse,
  requestedCalendarEventAnalysis,
} from './calendar-event-analysis.js';
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
      minimumInPersonGapMinutes: 30,
    });
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
          links: [{ label: 'Open event', url: 'https://calendar.example/event/45' }],
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
    expect(text).toContain('[Open event](https://calendar.example/event/45)');
    expect(text).not.toContain('Short meeting');
    expect(text).not.toContain('Cancelled');
    expect(text).not.toContain('Duplicate overnight event');
  });

  it('keeps missing-time results as a lower bound rather than guessing a duration', () => {
    const text = calendarEventAnalysisResponse({
      request: { weekdayCount: 2, minimumDurationMinutes: 45 },
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
    expect(text).toContain('at least 0 in the checked subset');
    expect(text).toContain(
      '2 event(s) with missing, all-day, or invalid start/end times were excluded',
    );
    expect(text).not.toContain('0 qualifying events.');
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
    expect(partial).toContain('at least 1 in the checked subset');
    expect(partial).toContain('coverage was incomplete');
  });
});
