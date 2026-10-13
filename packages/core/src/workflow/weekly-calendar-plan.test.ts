import { describe, expect, it } from 'vitest';
import { requestedCalendarPlanOptions } from './calendar-plan-intent.js';
import { weeklyCalendarPlan, weeklyCalendarPlanResult } from './weekly-calendar-plan.js';

const timeMin = '2026-10-12T07:00:00.000Z';
const timeMax = '2026-10-19T07:00:00.000Z';

function evidence(
  options: {
    timeMin?: string;
    timeMax?: string;
    busy?: unknown[];
    availabilityComplete?: boolean;
    unavailable?: unknown[];
    pages?: Array<Record<string, unknown>>;
  } = {},
) {
  return [
    {
      toolName: 'calendar.availability',
      status: 'succeeded',
      args: { timeMin: options.timeMin ?? timeMin, timeMax: options.timeMax ?? timeMax },
      result: {
        busy: options.busy ?? [],
        complete: options.availabilityComplete ?? true,
        unavailable: options.unavailable ?? [],
        calendarsChecked: ['Work', 'Personal'],
      },
    },
    ...(options.pages ?? [
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        args: {
          timeMin: options.timeMin ?? timeMin,
          timeMax: options.timeMax ?? timeMax,
          maxResults: 50,
        },
        result: { events: [], complete: true, calendarRosterComplete: true, unavailable: [] },
      },
    ]),
  ];
}

describe('weeklyCalendarPlan', () => {
  it('proposes three weekday focus blocks and states that no calendar was edited', () => {
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence() as never,
    });
    expect(text).toContain('review-only plan for next week');
    expect(text).toContain('I haven’t changed your calendar.');
    expect(text.match(/\(90 minutes\)/g)).toHaveLength(3);
    expect(text).toContain('15-minute break');
    expect(text).toContain('assumed to be 9 AM–5 PM');
  });

  it('keeps incomplete coverage tentative and names unavailable calendars without claiming clear time', () => {
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        availabilityComplete: false,
        unavailable: ['Shared calendar'],
      }) as never,
    });
    expect(text).toContain('Coverage is incomplete');
    expect(text).toContain('Shared calendar');
    expect(text).toContain('not confirmed free');
    expect(text).not.toContain('no overlapping attended events');
  });

  it('reports the overloaded-day assessment even when no checked day exceeds the heuristic', () => {
    const complete = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence() as never,
    });
    expect(complete).toContain('No checked working day reaches the 6-hour busy-time threshold');
    const partial = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({ availabilityComplete: false, unavailable: ['Shared'] }) as never,
    });
    expect(partial).toContain('No checked working day reaches the 6-hour busy-time threshold');
    expect(partial).toContain('missing coverage could change this assessment');
    const invalid = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({ busy: [{ start: 'invalid', end: 'invalid' }] }) as never,
    });
    expect(invalid).toContain('I could not assess overloaded days from usable free/busy data');
    expect(invalid).not.toContain('No checked working day reaches');
  });

  it('reserves estimated travel time for a physical shared event while keeping attendance uncertain', () => {
    const shared = {
      eventId: 'shared-physical',
      calendarId: 'family',
      summary: 'Shared appointment',
      start: '2026-10-12T18:00:00Z',
      end: '2026-10-12T19:00:00Z',
      blocksTime: true,
      location: '120 Example Street',
    };
    const busy = [
      { start: '2026-10-12T16:00:00Z', end: '2026-10-12T17:30:00Z' },
      { start: shared.start, end: shared.end },
      ...[13, 14, 15, 16].map((day) => ({
        start: `2026-10-${day}T16:00:00Z`,
        end: `2026-10-${day + 1}T00:00:00Z`,
      })),
    ];
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy,
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax },
            result: {
              events: [shared],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
    });
    expect(text).toContain('estimated 30-minute travel buffer');
    expect(text).toContain('shared-calendar attendance is unconfirmed');
    expect(text).toContain('- Mon, Oct 12, 12:30 PM');
    expect(text).not.toContain('- Mon, Oct 12, 12:00 PM');
    expect(text).toContain('not a route estimate');
  });

  it('does not infer free time from malformed busy intervals', () => {
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({ busy: [{ start: 'not-a-date', end: 'also-not-a-date' }] }) as never,
    });
    expect(text).toContain('Free/busy coverage could not be fully verified');
    expect(text).toContain('did not suggest focus times');
    expect(text).not.toContain('Tentative focus blocks');
    expect(text).not.toContain('I found no overlapping attended events');
  });

  it('uses event attendance for conflicts and treats shared-calendar uncertainty as potential', () => {
    const events = [
      {
        eventId: 'a',
        calendarId: 'work',
        summary: 'Review',
        start: '2026-10-12T17:00:00Z',
        end: '2026-10-12T18:00:00Z',
        ownerResponse: 'accepted',
        blocksTime: true,
      },
      {
        eventId: 'b',
        calendarId: 'shared',
        summary: 'Shared hold',
        start: '2026-10-12T17:30:00Z',
        end: '2026-10-12T18:30:00Z',
        blocksTime: true,
      },
    ];
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: { events, complete: true, calendarRosterComplete: true, unavailable: [] },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).toContain('Possible overlap: Review and Shared hold');
    expect(text).not.toContain('Scheduling conflict: Review and Shared hold');
    expect(text).toContain('Recommended check: confirm whether you need to attend');
  });

  it('recommends reviewing verified conflicts without choosing which event to move', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'a',
                calendarId: 'work',
                summary: 'Planning',
                start: '2026-10-12T17:00:00Z',
                end: '2026-10-12T18:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
              {
                eventId: 'b',
                calendarId: 'personal',
                summary: 'Appointment',
                start: '2026-10-12T17:30:00Z',
                end: '2026-10-12T18:30:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).toContain('Scheduling conflict: Planning and Appointment');
    expect(text).toContain('Recommended change: review the overlapping events');
    expect(text).not.toContain('I found no overlapping attended events');
    expect(text).not.toContain('move Planning');
    expect(text).not.toContain('move Appointment');
  });

  it('does not call an all-day hotel conflict or use it as attendance evidence', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'hotel',
                calendarId: 'travel',
                summary: 'Hotel stay',
                start: '2026-10-12T07:00:00Z',
                end: '2026-10-14T07:00:00Z',
                allDay: true,
                ownerResponse: 'accepted',
                blocksTime: true,
              },
              {
                eventId: 'meeting',
                calendarId: 'work',
                summary: 'Meeting',
                start: '2026-10-12T17:00:00Z',
                end: '2026-10-12T18:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).not.toContain('Scheduling conflict: Hotel stay');
  });

  it('does not treat a multi-day hotel reservation as an attendance conflict or travel event', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'hotel',
                calendarId: 'travel',
                summary: 'Hotel stay',
                start: '2026-10-12T07:00:00Z',
                end: '2026-10-16T07:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
                location: 'Downtown',
              },
              {
                eventId: 'meeting',
                calendarId: 'work',
                summary: 'Planning meeting',
                start: '2026-10-12T17:00:00Z',
                end: '2026-10-12T18:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).not.toContain('Possible overlap: Hotel stay');
    expect(text).not.toContain('Scheduling conflict: Hotel stay');
    expect(text).not.toContain('travel buffer around explicitly in-person events');
  });

  it('recognizes a long stay from explicit lodging description when the property title is not generic', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'hotel-screen-title',
                calendarId: 'travel',
                summary: 'NH Collection Berlin Mitte am Checkpoint Charlie',
                description:
                  'Hotel reservation: overnight stay, check in October 12 and check out October 16.',
                start: '2026-10-12T07:00:00Z',
                end: '2026-10-16T07:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
                location: 'Berlin',
              },
              {
                eventId: 'meeting',
                calendarId: 'work',
                summary: 'Planning meeting',
                start: '2026-10-12T17:00:00Z',
                end: '2026-10-12T18:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).not.toContain('Possible overlap: NH Collection');
    expect(text).not.toContain('Scheduling conflict: NH Collection');
    expect(text).not.toContain('travel buffer around explicitly in-person events');
  });

  it('keeps an unclassified long blocking engagement as a possible overlap', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'retreat',
                calendarId: 'work',
                summary: 'Leadership retreat',
                start: '2026-10-12T07:00:00Z',
                end: '2026-10-14T07:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
              {
                eventId: 'meeting',
                calendarId: 'work',
                summary: 'Planning meeting',
                start: '2026-10-12T17:00:00Z',
                end: '2026-10-12T18:00:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).toContain('Possible overlap: Leadership retreat and Planning meeting');
    expect(text).not.toContain('Scheduling conflict: Leadership retreat');
  });

  it('can place three blocks across two usable days without overlapping the break interval', () => {
    const busy = [
      { start: '2026-10-14T16:00:00Z', end: '2026-10-15T00:00:00Z' },
      { start: '2026-10-15T16:00:00Z', end: '2026-10-16T00:00:00Z' },
      { start: '2026-10-16T16:00:00Z', end: '2026-10-17T00:00:00Z' },
    ];
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({ busy }) as never,
    });
    const slots = text.split('\n').filter((line) => line.startsWith('- '));
    expect(slots).toHaveLength(3);
    expect(new Set(slots.map((line) => line.slice(2, 13))).size).toBe(2);
    expect(text).not.toContain('couldn’t identify suitable 90-minute blocks');
  });

  it('reports a typed shortfall when fewer than three blocks fit', () => {
    const busy = [
      { start: '2026-10-12T16:00:00Z', end: '2026-10-13T00:00:00Z' },
      { start: '2026-10-13T17:45:00Z', end: '2026-10-14T00:00:00Z' },
      { start: '2026-10-14T16:00:00Z', end: '2026-10-15T00:00:00Z' },
      { start: '2026-10-15T16:00:00Z', end: '2026-10-16T00:00:00Z' },
      { start: '2026-10-16T16:00:00Z', end: '2026-10-17T00:00:00Z' },
    ];
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({ busy }) as never,
    });
    expect(result).toMatchObject({ coverageComplete: true, slotCount: 1 });
    expect(result.text).toContain('I found 1 of 3 requested focus blocks');
  });

  it('uses DST-aware local labels and refuses to suggest times without a timezone', () => {
    const afterDst = weeklyCalendarPlan({
      timeMin: '2026-11-02T08:00:00.000Z',
      timeMax: '2026-11-09T08:00:00.000Z',
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: '2026-11-02T08:00:00.000Z',
        timeMax: '2026-11-09T08:00:00.000Z',
      }) as never,
    });
    expect(afterDst).toContain('Mon, Nov 2');
    const missingZone = weeklyCalendarPlan({ timeMin, timeMax, evidence: evidence() as never });
    expect(missingZone).toContain('time zone is unavailable');
    expect(missingZone).not.toContain('Tentative focus blocks');
  });

  it('only includes strict Google Calendar event URLs', () => {
    const rows = evidence({
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            events: [
              {
                eventId: 'safe',
                summary: 'Planning',
                start: '2026-10-12T18:00:00Z',
                end: '2026-10-12T18:30:00Z',
                links: [
                  { type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=abc' },
                ],
              },
              {
                eventId: 'unsafe',
                summary: 'Private',
                start: '2026-10-12T19:00:00Z',
                end: '2026-10-12T19:30:00Z',
                links: [{ type: 'calendar', url: 'https://example.test/event/secret' }],
              },
            ],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
    expect(text).toContain('https://calendar.google.com/calendar/event?eid=abc');
    expect(text).not.toContain('example.test');
  });
});

describe('requested focus-plan variations', () => {
  const prompt =
    'Review my calendar for the next three working days. Find two 60-minute focus blocks between 9 AM and 5 PM, allowing 15-minute breaks around meetings. Mark coverage limits and show the plan; do not create events.';
  it('keeps the requested count, duration, window and meeting break constraints', () => {
    const plan = requestedCalendarPlanOptions(prompt);
    expect(plan).toEqual({
      focusMinutes: 60,
      slotCount: 2,
      breakMinutes: 15,
      meetingBufferMinutes: 15,
      workingDays: 3,
      windowLabel: 'the next 3 working days',
    });
    const end = '2026-10-15T07:00:00.000Z';
    const meeting = {
      eventId: 'morning',
      calendarId: 'Work',
      summary: 'Review',
      start: '2026-10-12T16:00:00Z',
      end: '2026-10-12T17:00:00Z',
      ownerResponse: 'accepted',
      location: 'Online',
      blocksTime: true,
    };
    const rows = evidence({
      timeMax: end,
      busy: [{ start: meeting.start, end: meeting.end }],
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax: end },
          result: {
            events: [meeting],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const answer = weeklyCalendarPlanResult({
      timeMin,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan,
    });
    expect(answer.slotCount).toBe(2);
    expect(answer.coverageComplete).toBe(true);
    expect(answer.text.match(/\(60 minutes\)/g)).toHaveLength(2);
    expect(answer.text).toContain('the next 3 working days');
    expect(answer.text).toContain('both sides of meetings');
    expect(answer.text).not.toContain('30-minute travel');
    expect(answer.text).not.toContain('90 minutes');
    expect(answer.text).not.toMatch(/- Mon, Oct 12, (9|10):00 AM/);
    expect(answer.text).toContain('I haven’t changed your calendar');
  });
  it.each(['Online', 'https://zoom.us/j/123', 'Microsoft Teams', 'Google Meet', 'Virtual meeting'])(
    'does not invent physical travel buffers for %s',
    (location) => {
      const event = {
        eventId: 'remote',
        calendarId: 'Work',
        summary: 'Review',
        start: '2026-10-12T18:00:00Z',
        end: '2026-10-12T19:00:00Z',
        location,
        blocksTime: true,
      };
      const text = weeklyCalendarPlan({
        timeMin,
        timeMax,
        timeZone: 'America/Los_Angeles',
        evidence: evidence({
          pages: [
            {
              toolName: 'calendar.list_events',
              status: 'succeeded',
              args: { timeMin, timeMax },
              result: {
                events: [event],
                complete: true,
                calendarRosterComplete: true,
                unavailable: [],
              },
            },
          ],
        }) as never,
      });
      expect(text).not.toContain('travel buffer');
    },
  );
  it('rejects malformed focus parameters instead of suggesting unusable slots', () => {
    const plan = {
      focusMinutes: Number.NaN,
      slotCount: 2,
      breakMinutes: 15,
      windowLabel: 'next week',
    };
    expect(
      weeklyCalendarPlanResult({
        timeMin,
        timeMax,
        timeZone: 'UTC',
        evidence: evidence() as never,
        plan,
      }),
    ).toMatchObject({ coverageComplete: false, slotCount: 0 });
  });
  it.each([
    'Create three focus blocks on my calendar next week.',
    'Review a hypothetical schedule for focus time next week. Do not read my calendar.',
    'Review my calendar next week with twelve 60-minute focus blocks.',
  ])('does not classify a different action as a bounded read-only proposal: %s', (text) => {
    expect(requestedCalendarPlanOptions(text)).toBeUndefined();
  });
});
