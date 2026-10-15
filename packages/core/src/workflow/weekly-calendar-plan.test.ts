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
    calendarsChecked?: string[];
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
        calendarsChecked: options.calendarsChecked ?? ['Work', 'Personal'],
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
    expect(text).toContain('Review-only plan for next week');
    expect(text).toContain('no calendar changes made.');
    expect(text.match(/\(90m\)/g)).toHaveLength(3);
    expect(text).toContain('15-minute break');
    expect(text).toContain('assumed 9 AM–5 PM');
    expect(text).toContain('| Candidate | Break |');
    expect(text.indexOf('| Candidate | Break |')).toBeLessThan(text.indexOf('Assumptions:'));
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
    expect(text).toContain('Limits:');
    expect(text).toContain('Shared calendar');
    expect(text).toContain('not confirmed free');
    expect(text).not.toContain('no overlapping attended events');
  });

  it('uses readable local dates for overloaded days and states the missing-coverage limit once', () => {
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        availabilityComplete: false,
        unavailable: ['Holiday calendar'],
        busy: [{ start: '2026-10-12T16:00:00Z', end: '2026-10-12T22:00:00Z' }],
      }) as never,
    });
    expect(text).toContain('Overloaded-day estimate: Mon, Oct 12');
    expect(text).not.toContain('Overloaded-day estimate: 2026-10-12');
    expect(text.match(/Confirm the missing calendars before relying on this review/g)).toHaveLength(
      1,
    );
    expect(text).toContain('Holiday calendar');
    expect(text).not.toMatch(/suggested focus times are confirmed free/i);
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

  it('assesses evening load and short turnarounds outside the assumed 9–5 window', () => {
    const first = {
      eventId: 'evening-review',
      calendarId: 'family',
      calendar: 'Family',
      summary: 'School review',
      start: '2026-10-13T18:00:00-07:00',
      end: '2026-10-13T18:45:00-07:00',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const second = {
      eventId: 'evening-practice',
      calendarId: 'sports',
      calendar: 'Sports',
      summary: 'Team practice',
      start: '2026-10-13T19:00:00-07:00',
      end: '2026-10-13T20:00:00-07:00',
      ownerResponse: 'tentative',
      blocksTime: true,
    };
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy: [
          { start: first.start, end: first.end },
          { start: second.start, end: second.end },
          { start: '2026-10-14T17:00:00-07:00', end: '2026-10-14T20:30:00-07:00' },
          { start: '2026-10-14T17:15:00-07:00', end: '2026-10-14T17:45:00-07:00' },
        ],
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax, maxResults: 50 },
            result: {
              events: [first, second],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
    });

    expect(result.text).toContain(
      'Evening-heavy estimate: Wed, Oct 14, 3.5 checked busy hours after 5 PM',
    );
    expect(result.text).toContain('unique occupied time; overlapping intervals count once');
    expect(result.text).toContain('Tight turnaround: School review ends Tue, Oct 13, 6:45 PM');
    expect(result.text).toContain(
      'Team practice starts Tue, Oct 13, 7:00 PM (15 min; attendance/travel unverified)',
    );
    expect(result.text).toContain('attendance/travel unverified');
    expect(result.text).toContain('assumed 9 AM–5 PM');
    expect(result.text).not.toContain('calendar changed');
  });

  it('keeps estimated travel buffers out of workload hours and merges overlapping source events', () => {
    const events = [
      { eventId: 'council', start: '2026-10-14T17:00:00-07:00', end: '2026-10-14T18:00:00-07:00' },
      { eventId: 'lesson', start: '2026-10-14T17:15:00-07:00', end: '2026-10-14T17:45:00-07:00' },
      { eventId: 'meeting', start: '2026-10-14T18:00:00-07:00', end: '2026-10-14T19:30:00-07:00' },
    ].map((event) => ({
      ...event,
      summary: event.eventId,
      calendarId: 'shared',
      blocksTime: true,
      location: '120 Example Street',
    }));
    const text = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy: events.map(({ start, end }) => ({ start, end })),
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax },
            result: { events, complete: true, calendarRosterComplete: true, unavailable: [] },
          },
        ],
      }) as never,
    });
    expect(text).toContain('estimated 30-minute travel buffers');
    // 17:00–19:30 is 2.5 unique source hours, below the 3-hour evening heuristic.
    // The overlap and 19:30–20:00 estimated return buffer must not inflate it.
    expect(text).not.toContain('Evening-heavy estimate');
    expect(text).toContain('attendance/travel unverified');
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
    expect(text).toContain('estimated 30-minute travel buffers');
    expect(text).toContain('some shared-event attendance is unconfirmed');
    expect(text).toContain('| Mon, Oct 12, 12:30 PM–2:00 PM');
    expect(text).not.toContain('| Mon, Oct 12, 12:00 PM–1:30 PM');
    expect(text).toContain('not route estimates');
  });

  it('adds the configured meeting gap to estimated travel around in-person events', () => {
    const start = '2026-10-12T07:00:00.000Z';
    const end = '2026-10-13T07:00:00.000Z';
    const event = {
      eventId: 'in-person-review',
      calendarId: 'Work',
      summary: 'In-person review',
      start: '2026-10-12T16:00:00Z',
      end: '2026-10-12T16:10:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
      location: '120 Example Street',
    };
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: start,
        timeMax: end,
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin: start, timeMax: end },
            result: {
              events: [event],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
      plan: {
        focusMinutes: 60,
        slotCount: 1,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        includeWorkloadAssessment: true,
        includeTravelBuffers: true,
        workingDays: 1,
        windowLabel: 'Monday',
      },
    });

    expect(result.text).toContain('| Mon, Oct 12, 10:00 AM–11:00 AM');
    expect(result.text).not.toContain('| Mon, Oct 12, 9:45 AM–10:45 AM');
    expect(result.text).toContain('15-minute buffers before and after meetings');
    expect(result.text).toContain(
      '30-minute travel buffers before and after physical events without video',
    );
  });

  it('keeps a nonblocking reminder out of busy-time and overlap claims', () => {
    const start = '2026-10-12T07:00:00.000Z';
    const end = '2026-10-13T07:00:00.000Z';
    const reminder = {
      eventId: 'pay-reminder',
      calendarId: 'Personal',
      summary: 'Payday reminder',
      start: '2026-10-12T16:00:00Z',
      end: '2026-10-12T18:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: false,
    };
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: start,
        timeMax: end,
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin: start, timeMax: end },
            result: {
              events: [reminder],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
      plan: {
        focusMinutes: 60,
        slotCount: 1,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        workingDays: 1,
        windowLabel: 'Monday',
      },
    });

    expect(result.slotCount).toBe(1);
    expect(result.text).toContain('| Mon, Oct 12, 9:00 AM–10:00 AM');
    expect(result.text).not.toContain('Possible overlap: Payday reminder');
    expect(result.text).not.toContain('Scheduling conflict: Payday reminder');
  });

  it('keeps focus candidates and overlap notes consistent with offset-bearing event timestamps', () => {
    const weekStart = '2026-10-19T07:00:00.000Z';
    const weekEnd = '2026-10-26T07:00:00.000Z';
    const events = [
      {
        eventId: 'monday-practice',
        calendarId: 'soccer',
        calendar: 'SF United Soccer',
        summary: 'U13B practice',
        start: '2026-10-19T10:00:00-07:00',
        end: '2026-10-19T11:30:00-07:00',
        blocksTime: true,
        ownerResponse: 'accepted',
        location: 'Gellert Park',
      },
      {
        eventId: 'wednesday-site-council',
        calendarId: 'pta',
        calendar: 'Alamo PTA',
        summary: 'Site Council',
        start: '2026-10-21T10:00:00-07:00',
        end: '2026-10-21T11:00:00-07:00',
        blocksTime: true,
        ownerResponse: 'accepted',
        location: 'Alamo Elementary School',
      },
      {
        eventId: 'wednesday-swim',
        calendarId: 'family',
        calendar: 'Family',
        summary: 'Freyja Swim',
        start: '2026-10-21T17:15:00-07:00',
        end: '2026-10-21T17:45:00-07:00',
        blocksTime: true,
        ownerResponse: 'accepted',
      },
      {
        eventId: 'saturday-festival',
        calendarId: 'family',
        calendar: 'Family',
        summary: 'Volunteering at Pumpkin Fest',
        start: '2026-10-24T10:50:00-07:00',
        end: '2026-10-24T15:10:00-07:00',
        blocksTime: true,
        ownerResponse: 'accepted',
      },
      {
        eventId: 'saturday-haircut',
        calendarId: 'personal',
        calendar: 'Personal',
        summary: 'Hair Cut',
        start: '2026-10-24T12:15:00-07:00',
        end: '2026-10-24T13:45:00-07:00',
        blocksTime: true,
        ownerResponse: 'accepted',
      },
    ];
    const rows = evidence({
      timeMin: weekStart,
      timeMax: weekEnd,
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin: weekStart, timeMax: weekEnd },
          result: { events, complete: true, calendarRosterComplete: true, unavailable: [] },
        },
      ],
    });

    const text = weeklyCalendarPlan({
      timeMin: weekStart,
      timeMax: weekEnd,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });

    expect(text).not.toContain('- Mon, Oct 19, 9:00 AM');
    expect(text).not.toContain('- Wed, Oct 21, 9:00 AM');
    expect(text).not.toContain('Possible overlap: Site Council and Freyja Swim');
    expect(text).toContain('Scheduling conflict: Volunteering at Pumpkin Fest and Hair Cut');
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
    expect(text).toContain('Attendance is unconfirmed for Shared hold.');
    expect(text).toContain('Next: confirm attendance for Shared hold');
    expect(text).toContain(
      'if attending, compare with Review, choose which event you would like to move, and ask its organizer whether a move is possible',
    );
    expect(text).not.toContain('lower-priority');
  });

  it('offers concrete conditional choices for verified conflicts without choosing what to move', () => {
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
                organizer: 'planner@example.test',
                links: [
                  {
                    type: 'calendar',
                    url: 'https://calendar.google.com/calendar/event?eid=planning',
                  },
                ],
              },
              {
                eventId: 'b',
                calendarId: 'personal',
                summary: 'Appointment',
                start: '2026-10-12T17:30:00Z',
                end: '2026-10-12T18:30:00Z',
                ownerResponse: 'accepted',
                blocksTime: true,
                organizer: 'host@example.test',
                links: [
                  {
                    type: 'calendar',
                    url: 'https://calendar.google.com/calendar/event?eid=appointment',
                  },
                ],
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
    expect(text).toContain(
      'Choice: keep Planning and ask the listed organizer (host@example.test) whether Appointment can move, or keep Appointment and ask the listed organizer (planner@example.test) whether Planning can move.',
    );
    expect(text).toContain('Both invites show accepted.');
    expect(
      text.match(/https:\/\/calendar\.google\.com\/calendar\/event\?eid=planning/g),
    ).toHaveLength(1);
    expect(
      text.match(/https:\/\/calendar\.google\.com\/calendar\/event\?eid=appointment/g),
    ).toHaveLength(1);
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

  it('blocks focus on the source-local date of a blocking all-day event without calling it a timed overlap', () => {
    const start = '2026-10-13T07:00:00.000Z';
    const end = '2026-10-14T07:00:00.000Z';
    const event = {
      eventId: 'conference-day',
      calendar: 'Work',
      calendarId: 'work-calendar',
      summary: 'Conference day',
      start: '2026-10-13',
      end: '2026-10-14',
      calendarTimeZone: 'America/Los_Angeles',
      allDay: true,
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: start,
        timeMax: end,
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin: start, timeMax: end },
            result: {
              events: [event],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
      plan: {
        focusMinutes: 60,
        slotCount: 1,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        workingDays: 1,
        windowLabel: 'Tuesday',
      },
    });

    expect(result.slotCount).toBe(0);
    expect(result.text).toContain('Conference day');
    expect(result.text).toContain('No 60-minute focus block plus its 15-minute break fit');
    expect(result.text).not.toContain('Possible overlap: Conference day');
    expect(result.text).not.toContain('Scheduling conflict: Conference day');
  });

  it('does not block focus for a source-zoned all-day lodging stay when provider busy is explained', () => {
    const start = '2026-10-13T07:00:00.000Z';
    const end = '2026-10-14T07:00:00.000Z';
    const stay = {
      eventId: 'all-day-stay',
      calendar: 'Travel',
      calendarId: 'travel-calendar',
      summary: 'Hotel stay in Berlin',
      description: 'Hotel reservation. Check-in October 12. Check-out October 16.',
      start: '2026-10-12',
      end: '2026-10-16',
      calendarTimeZone: 'America/Los_Angeles',
      allDay: true,
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: start,
        timeMax: end,
        busy: [{ start, end, calendar: 'Travel' }],
        calendarsChecked: ['Travel'],
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin: start, timeMax: end },
            result: {
              events: [stay],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
      plan: {
        focusMinutes: 60,
        slotCount: 1,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        workingDays: 1,
        windowLabel: 'Tuesday',
      },
    });

    expect(result.slotCount).toBe(1);
    expect(result.text).toContain('conditional slots assume lodging context');
    expect(result.text).not.toContain('Possible overlap: Hotel stay');
  });

  it('does not block focus for a nonblocking all-day reminder', () => {
    const start = '2026-10-13T07:00:00.000Z';
    const end = '2026-10-14T07:00:00.000Z';
    const reminder = {
      eventId: 'all-day-payday',
      calendar: 'Personal',
      calendarId: 'personal-calendar',
      summary: 'Payday reminder',
      start: '2026-10-13',
      end: '2026-10-14',
      calendarTimeZone: 'America/Los_Angeles',
      allDay: true,
      blocksTime: false,
    };
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        timeMin: start,
        timeMax: end,
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin: start, timeMax: end },
            result: {
              events: [reminder],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
      plan: {
        focusMinutes: 60,
        slotCount: 1,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        workingDays: 1,
        windowLabel: 'Tuesday',
      },
    });

    expect(result.slotCount).toBe(1);
    expect(result.text).toContain('| Tue, Oct 13, 9:00 AM–');
    expect(result.text).not.toContain('Possible overlap: Payday reminder');
  });

  it('keeps a title-only multi-day hotel event in overlap review', () => {
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
    expect(text).toContain('Possible overlap: Hotel stay and Planning meeting');
    expect(text).toContain(
      'estimated 30-minute travel buffers before and after physical events without video',
    );
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
    const slots = text.split('\n').filter((line) => /^\| [A-Z][a-z]{2},/.test(line));
    expect(slots).toHaveLength(3);
    expect(
      new Set(slots.map((line) => line.match(/\| ([A-Z][a-z]{2}, [A-Z][a-z]{2} \d+)/)?.[1])).size,
    ).toBe(2);
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

  it('names a verified all-day event that blocks every requested focus window', () => {
    const travelStart = '2026-10-12';
    const travelEnd = '2026-10-18';
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy: [
          {
            start: '2026-10-11T22:00:00.000Z',
            end: '2026-10-17T22:00:00.000Z',
            calendar: 'Travel',
          },
        ],
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax, maxResults: 50 },
            result: {
              events: [
                {
                  eventId: 'all-day-travel',
                  calendarId: 'Travel',
                  summary: 'Conference travel',
                  start: travelStart,
                  end: travelEnd,
                  allDay: true,
                  calendarTimeZone: 'Europe/Berlin',
                  blocksTime: true,
                  links: [
                    {
                      type: 'calendar',
                      url: 'https://calendar.google.com/calendar/event?eid=travel',
                    },
                  ],
                },
              ],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
    });

    expect(result).toMatchObject({ coverageComplete: true, slotCount: 0 });
    expect(result.text).toContain('Checked events overlapping possible focus windows include');
    expect(result.text).toContain(
      '[Conference travel](<https://calendar.google.com/calendar/event?eid=travel>)',
    );
    expect(result.text).toContain(
      'No 90-minute focus block plus its 15-minute break fit in the checked data.',
    );
    expect(result.text).not.toContain('[Event 1]');
  });

  it.each([
    {
      description: 'unknown source time zone',
      calendarTimeZone: undefined,
      busyCalendar: 'Travel',
      blocksTime: true,
      coverageComplete: false,
    },
    {
      description: 'different busy calendar',
      calendarTimeZone: 'Europe/Berlin',
      busyCalendar: 'Personal',
      blocksTime: false,
      coverageComplete: true,
    },
  ])('does not attribute an all-day busy block to an event with $description', (scenario) => {
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy: [
          {
            start: '2026-10-11T22:00:00.000Z',
            end: '2026-10-17T22:00:00.000Z',
            calendar: scenario.busyCalendar,
          },
        ],
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax, maxResults: 50 },
            result: {
              events: [
                {
                  eventId: 'all-day-travel',
                  calendarId: 'Travel',
                  summary: 'Conference travel',
                  start: '2026-10-12',
                  end: '2026-10-18',
                  allDay: true,
                  ...(scenario.calendarTimeZone
                    ? { calendarTimeZone: scenario.calendarTimeZone }
                    : {}),
                  blocksTime: scenario.blocksTime,
                },
              ],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
    });

    expect(result).toMatchObject({ coverageComplete: scenario.coverageComplete, slotCount: 0 });
    expect(result.text).not.toContain('Checked events overlapping possible focus windows include');
    expect(result.text).toContain('I found 0 of 3 requested focus blocks');
  });

  it('does not attribute a merged weekday busy interval to an all-day event confined to Sunday', () => {
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: evidence({
        busy: [
          {
            start: '2026-10-10T22:00:00.000Z',
            end: '2026-10-17T22:00:00.000Z',
            calendar: 'Travel',
          },
        ],
        pages: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { timeMin, timeMax, maxResults: 50 },
            result: {
              events: [
                {
                  eventId: 'sunday-only',
                  calendarId: 'Travel',
                  summary: 'Sunday event',
                  start: '2026-10-11',
                  end: '2026-10-12',
                  allDay: true,
                  calendarTimeZone: 'Europe/Berlin',
                  blocksTime: true,
                },
              ],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          },
        ],
      }) as never,
    });

    expect(result).toMatchObject({ coverageComplete: true, slotCount: 0 });
    expect(result.text).not.toContain('Checked events overlapping possible focus windows include');
    expect(result.text).toContain('I found 0 of 3 requested focus blocks');
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

  it.each([
    {
      timeZone: 'Pacific/Kiritimati',
      timeMin: '2026-10-11T10:00:00Z',
      timeMax: '2026-10-18T10:00:00Z',
      busy: { start: '2026-10-11T19:00:00Z', end: '2026-10-12T01:00:00Z' },
    },
    {
      timeZone: 'Etc/GMT+12',
      timeMin: '2026-10-12T12:00:00Z',
      timeMax: '2026-10-19T12:00:00Z',
      busy: { start: '2026-10-12T21:00:00Z', end: '2026-10-13T03:00:00Z' },
    },
  ])('keeps an overloaded civil date stable in the date-line zone $timeZone', (scenario) => {
    const text = weeklyCalendarPlan({
      timeMin: scenario.timeMin,
      timeMax: scenario.timeMax,
      timeZone: scenario.timeZone,
      evidence: evidence({
        timeMin: scenario.timeMin,
        timeMax: scenario.timeMax,
        busy: [scenario.busy],
      }) as never,
    });
    expect(text).toContain('Overloaded-day estimate: Mon, Oct 12');
    expect(text).not.toContain('Overloaded-day estimate: Tue, Oct 13');
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
                summary: 'Planning [Q2] *review*',
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
    expect(text).toContain(
      '[Planning \\[Q2\\] \\*review\\*](<https://calendar.google.com/calendar/event?eid=abc>)',
    );
    expect(text).toContain('https://calendar.google.com/calendar/event?eid=abc');
    expect(text).not.toContain('[Event 1]');
    expect(text).not.toContain('example.test');
  });
});

describe('requested focus-plan variations', () => {
  const prompt =
    'Look at my calendar for the next three working days. Suggest two 60-minute focus slots between 09:00 and 17:00, leave 15-minute breaks around meetings, and explain any limits in the availability check. Show the plan for review without creating events.';
  const threeDayStart = '2026-10-13T07:00:00.000Z';
  const threeDayEnd = '2026-10-16T07:00:00.000Z';
  const threeDayPlan = {
    focusMinutes: 60,
    slotCount: 2,
    breakMinutes: 15,
    meetingBufferMinutes: 15,
    includeWorkloadAssessment: false,
    includeTravelBuffers: false,
    windowLabel: 'the next 3 working days',
    workingDays: 3,
  };

  function stayEvidence(
    options: {
      stay?: Record<string, unknown>;
      availabilityBusy?: unknown[];
      checked?: string[];
      unavailable?: string[];
      eventPage?: Record<string, unknown>;
      extraEvents?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const stay = options.stay ?? {
      eventId: 'stay',
      calendar: 'Travel',
      calendarId: 'travel-calendar',
      summary: 'Hotel stay in Berlin',
      description: 'Hotel reservation. Check-in: October 10. Check-out: October 17.',
      start: '2026-10-10T06:00:00-07:00',
      end: '2026-10-17T02:00:00-07:00',
      blocksTime: true,
    };
    return [
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin: threeDayStart, timeMax: threeDayEnd },
        result: {
          busy: options.availabilityBusy ?? [
            { start: threeDayStart, end: threeDayEnd, calendar: 'Travel' },
          ],
          calendarsChecked: options.checked ?? ['Travel', 'Work', 'Holidays'],
          complete: false,
          unavailable: options.unavailable ?? ['Holidays'],
        },
      },
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        args: { timeMin: threeDayStart, timeMax: threeDayEnd, maxResults: 50 },
        result: {
          events: [stay, ...(options.extraEvents ?? [])],
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
          ...(options.eventPage ?? {}),
        },
      },
    ];
  }

  it('offers review candidates only conditionally when one complete stay explains provider busy', () => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence({
        availabilityBusy: [
          { start: threeDayStart, end: threeDayEnd, calendar: 'Travel' },
          {
            start: '2026-10-13T16:00:00Z',
            end: '2026-10-13T17:00:00Z',
            calendar: 'Work',
          },
          {
            start: '2026-10-14T16:00:00Z',
            end: '2026-10-14T17:00:00Z',
            calendar: 'Work',
          },
          {
            start: '2026-10-15T16:00:00Z',
            end: '2026-10-15T17:00:00Z',
            calendar: 'Work',
          },
        ],
        checked: ['Travel', 'Work', 'Holidays'],
        extraEvents: [
          {
            eventId: 'work-meeting',
            calendar: 'Work',
            calendarId: 'work-calendar',
            summary: 'Work meeting',
            start: '2026-10-13T09:00:00-07:00',
            end: '2026-10-13T10:00:00-07:00',
            ownerResponse: 'accepted',
            blocksTime: true,
          },
          ...['2026-10-14', '2026-10-15'].map((day) => ({
            eventId: `work-meeting-${day}`,
            calendar: 'Work',
            calendarId: 'work-calendar',
            summary: 'Work meeting',
            start: `${day}T09:00:00-07:00`,
            end: `${day}T10:00:00-07:00`,
            ownerResponse: 'accepted',
            blocksTime: true,
          })),
        ],
      }) as never,
      plan: threeDayPlan,
    });

    expect(result.slotCount).toBe(2);
    expect(result.coverageComplete).toBe(false);
    expect(result.text).toContain('Hotel stay in Berlin');
    expect(result.text).toContain('feed still reports busy');
    expect(result.text).toContain('not confirmed free');
    expect(result.text).toContain('Unavailable free/busy or event coverage: Holidays');
    expect(result.text).toContain('Focus candidates (not availability-cleared)');
    expect(result.text).toContain('conditional slots assume lodging context');
    expect(result.text.match(/\(60m\)/g)).toHaveLength(2);
    expect(result.text).toContain('Tue, Oct 13, 10:15 AM');
    expect(result.text).toContain('Wed, Oct 14, 10:15 AM');
    expect(result.text).not.toContain('Tue, Oct 13, 9:00 AM');
    expect(result.text).toContain('no calendar changes made');
  });

  it.each([
    ['Hotel leadership conference', 'Multi-day conference at the hotel venue.'],
    ['Hotel check-in training', 'Training for staff on the hotel check-in process.'],
  ])('does not discount provider busy for a non-stay event titled %s', (summary, description) => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence({
        stay: {
          eventId: 'non-stay',
          calendar: 'Travel',
          calendarId: 'travel-calendar',
          summary,
          description,
          start: '2026-10-12T07:00:00.000Z',
          end: '2026-10-17T07:00:00.000Z',
          ownerResponse: 'accepted',
          blocksTime: true,
        },
        checked: ['Travel'],
        unavailable: [],
        availabilityBusy: [{ start: threeDayStart, end: threeDayEnd, calendar: 'Travel' }],
      }) as never,
    });

    expect(result.slotCount).toBe(0);
    expect(result.text).toContain('I couldn’t identify suitable');
    expect(result.text).toContain('Overloaded-day estimate');
    expect(result.text).not.toContain('Conditional on treating');
    expect(result.text).not.toContain('provider still reports busy across this window');
  });

  it('rebuilds an overlapping timed meeting as a separate blocker when explaining a stay interval', () => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence({
        availabilityBusy: [
          { start: threeDayStart, end: threeDayEnd, calendar: 'Travel' },
          {
            start: '2026-10-14T07:00:00.000Z',
            end: '2026-10-15T07:00:00.000Z',
            calendar: 'Other busy calendar',
          },
          {
            start: '2026-10-15T07:00:00.000Z',
            end: '2026-10-16T07:00:00.000Z',
            calendar: 'Other busy calendar',
          },
        ],
        extraEvents: [
          {
            eventId: 'meeting',
            calendar: 'Travel',
            calendarId: 'travel-calendar',
            summary: 'Travel planning meeting',
            start: '2026-10-13T09:00:00-07:00',
            end: '2026-10-13T10:00:00-07:00',
            ownerResponse: 'accepted',
            blocksTime: true,
          },
        ],
      }) as never,
      plan: { ...threeDayPlan, slotCount: 1 },
    });

    expect(result.slotCount).toBe(1);
    expect(result.text).toContain('Focus candidates (not availability-cleared)');
    expect(result.text).toContain('Tue, Oct 13, 10:15 AM');
    expect(result.text).not.toContain('Tue, Oct 13, 9:00 AM');
    expect(result.text).toContain('feed still reports busy');
  });

  it('keeps the full provider interval blocking when an all-day event overlaps the stay', () => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence({
        extraEvents: [
          {
            eventId: 'all-day-hold',
            calendar: 'Travel',
            calendarId: 'travel-calendar',
            calendarTimeZone: 'America/Los_Angeles',
            summary: 'Travel day hold',
            start: '2026-10-13',
            end: '2026-10-16',
            allDay: true,
            ownerResponse: 'accepted',
            blocksTime: true,
          },
        ],
      }) as never,
      plan: threeDayPlan,
    });

    expect(result.slotCount).toBe(0);
    expect(result.text).toContain('I couldn’t identify suitable 60-minute blocks');
    expect(result.text).not.toContain('Focus candidates (not availability-cleared)');
  });

  it.each([
    {
      label: 'a same-calendar offsetless local event',
      extraEvents: [
        {
          eventId: 'local-event',
          calendar: 'Travel',
          calendarId: 'travel-calendar',
          summary: 'Local time meeting',
          start: '2026-10-13T09:00:00',
          end: '2026-10-13T10:00:00',
          ownerResponse: 'accepted',
          blocksTime: true,
        },
      ],
    },
    {
      label: 'a declined event still present in provider busy',
      extraEvents: [
        {
          eventId: 'declined-event',
          calendar: 'Travel',
          calendarId: 'travel-calendar',
          summary: 'Declined but busy event',
          start: '2026-10-13T09:00:00-07:00',
          end: '2026-10-13T10:00:00-07:00',
          ownerResponse: 'declined',
          blocksTime: true,
        },
      ],
    },
  ])('keeps provider busy for $label', ({ extraEvents }) => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence({ extraEvents }) as never,
      plan: threeDayPlan,
    });

    expect(result.slotCount).toBe(0);
    expect(result.text).not.toContain('Focus candidates (not availability-cleared)');
  });

  it('finds review-only weekday candidates from the captured complete event roster while retaining the missing free/busy limit', () => {
    const start = '2026-10-14T07:00:00.000Z';
    const end = '2026-10-17T07:00:00.000Z';
    const stay = {
      eventId: 'hotel',
      calendar: 'bot@bmson.com',
      calendarId: 'bot@bmson.com',
      summary: 'NH Collection Berlin Mitte am Checkpoint Charlie',
      description:
        'Hotel stay booked via Egencia\nCheck-in: October 10, 2026\nCheck-out: October 17, 2026 (7 nights)',
      start: '2026-10-10T06:00:00-07:00',
      end: '2026-10-17T02:00:00-07:00',
      blocksTime: true,
    };
    const event = (
      eventId: string,
      calendar: string,
      calendarId: string,
      summary: string,
      eventStart: string,
      eventEnd: string,
      extra: Record<string, unknown> = {},
    ) => ({
      eventId,
      calendar,
      calendarId,
      summary,
      start: eventStart,
      end: eventEnd,
      blocksTime: true,
      ...extra,
    });
    const rows = [
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin: start, timeMax: end },
        result: {
          busy: [
            { start, end, calendar: 'bot@bmson.com' },
            {
              start: '2026-10-14T16:00:00Z',
              end: '2026-10-14T16:10:00Z',
              calendar: 'Family',
            },
            {
              start: '2026-10-14T22:30:00Z',
              end: '2026-10-14T23:00:00Z',
              calendar: 'Family',
            },
            {
              start: '2026-10-15T00:15:00Z',
              end: '2026-10-15T00:45:00Z',
              calendar: 'Family',
            },
            {
              start: '2026-10-15T16:50:00Z',
              end: '2026-10-15T19:00:00Z',
              calendar: 'Family',
            },
            {
              start: '2026-10-16T00:00:00Z',
              end: '2026-10-17T00:00:00Z',
              calendar: 'Baldvin’s iPhone',
            },
            {
              start: '2026-10-16T00:00:00Z',
              end: '2026-10-16T01:30:00Z',
              calendar: 'SF United Soccer',
            },
            {
              start: '2026-10-16T20:20:00Z',
              end: '2026-10-16T23:10:00Z',
              calendar: 'Family',
            },
            {
              start: '2026-10-17T00:30:00Z',
              end: '2026-10-17T01:30:00Z',
              calendar: 'Family',
            },
          ],
          calendarsChecked: ['bot@bmson.com', 'Family', 'Holidays in United States'],
          complete: false,
          unavailable: ['Holidays in United States'],
        },
      },
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        args: { timeMin: start, timeMax: end, maxResults: 50 },
        result: {
          events: [
            stay,
            event(
              'vaccine',
              'Family',
              'family-calendar',
              'Brynjar - Flu Vaccine',
              '2026-10-14T16:00:00Z',
              '2026-10-14T16:10:00Z',
              { location: 'SF Bay Pediatrics' },
            ),
            event(
              'orthodontist',
              'Family',
              'family-calendar',
              'Orthodontist',
              '2026-10-14T22:30:00Z',
              '2026-10-14T23:00:00Z',
              { location: 'Oviedo Orthodontics' },
            ),
            event(
              'swim',
              'Family',
              'family-calendar',
              'Freyja Swim',
              '2026-10-15T00:15:00Z',
              '2026-10-15T00:45:00Z',
              { location: 'La Petite Baleen Swim Schools' },
            ),
            event(
              'field-trip',
              'Family',
              'family-calendar',
              'Freyja - Library Field Trip',
              '2026-10-15T16:50:00Z',
              '2026-10-15T19:00:00Z',
              { location: 'Richmond Library' },
            ),
            event(
              'all-day-hold',
              'Baldvin’s iPhone',
              'iphone-calendar',
              'Útborgun',
              '2026-10-16',
              '2026-10-17',
              { allDay: true, calendarTimeZone: 'UTC', blocksTime: false },
            ),
            event(
              'paycheck-family',
              'Family',
              'family-calendar',
              'Paycheck from Zendesk',
              '2026-10-16',
              '2026-10-17',
              { allDay: true, blocksTime: false },
            ),
            event(
              'soccer',
              'SF United Soccer',
              'soccer-calendar',
              '26/27 U13B Azul - Fall Practice',
              '2026-10-16T00:00:00-07:00',
              '2026-10-16T01:30:00-07:00',
              { location: 'Gellert Park' },
            ),
            event(
              'exam',
              'Family',
              'family-calendar',
              'Dr. Chan - Annual Exam',
              '2026-10-16T20:20:00Z',
              '2026-10-16T21:20:00Z',
              { location: '450 Sutter St' },
            ),
            event(
              'wheel-kids',
              'Family',
              'family-calendar',
              'Wheel Kids at Alamo',
              '2026-10-16T21:10:00Z',
              '2026-10-16T23:10:00Z',
              { location: 'Alamo Elementary School' },
            ),
            event(
              'goalie',
              'Family',
              'family-calendar',
              'Goalie Training',
              '2026-10-17T00:30:00Z',
              '2026-10-17T01:30:00Z',
              { location: 'Crocker Amazon Soccer Fields' },
            ),
            event(
              'flight',
              'bot@bmson.com',
              'bot@bmson.com',
              'BER → SFO flight (United)',
              '2026-10-16T21:10:00-07:00',
              '2026-10-17T08:15:00-07:00',
              { description: 'Operated by United' },
            ),
          ],
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
        },
      },
    ];

    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan: threeDayPlan,
    });

    expect(result.slotCount).toBe(2);
    expect(result.coverageComplete).toBe(false);
    expect(result.text).toContain(
      'Unavailable free/busy or event coverage: Holidays in United States',
    );
    expect(result.text).toContain('feed still reports busy');
    expect(result.text).toContain('not confirmed free');
    expect(result.text).toContain('Wed, Oct 14');
    expect(result.text.indexOf('| Candidate | Break |')).toBeLessThan(
      result.text.indexOf('Possible overlap:'),
    );
    expect(result.text.match(/^Limits:/gm)).toHaveLength(1);
    expect(result.text.match(/^Assumptions:/gm)).toHaveLength(1);
    expect(result.text).toContain('Thu, Oct 15');
    expect(result.text).not.toMatch(/^- Fri, Oct 16,/m);
    expect(result.text).toContain('no calendar changes made');
  });

  it('keeps a timed flight blocking candidates when it overlaps a lodging-explained busy window', () => {
    const start = '2026-10-16T20:00:00.000Z';
    const end = '2026-10-16T21:30:00.000Z';
    const hotel = {
      eventId: 'hotel',
      calendar: 'Travel',
      calendarId: 'travel-calendar',
      summary: 'Hotel stay in Berlin',
      description: 'Hotel reservation. Check-in: October 10. Check-out: October 17.',
      start: '2026-10-10T06:00:00-07:00',
      end: '2026-10-17T02:00:00-07:00',
      blocksTime: true,
    };
    const flight = {
      eventId: 'flight',
      calendar: 'Travel',
      calendarId: 'travel-calendar',
      summary: 'Flight home',
      start: '2026-10-16T14:10:00-07:00',
      end: '2026-10-16T15:15:00-07:00',
      blocksTime: true,
    };
    const rows = [
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin: start, timeMax: end },
        result: {
          busy: [{ start, end, calendar: 'Travel' }],
          complete: true,
          calendarsChecked: ['Travel'],
          unavailable: [],
        },
      },
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        args: { timeMin: start, timeMax: end },
        result: {
          events: [hotel, flight],
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
        },
      },
    ];
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan: { ...threeDayPlan, slotCount: 1, windowLabel: 'Friday afternoon' },
    });
    const noFlightRows = rows.map((row) =>
      row.toolName === 'calendar.list_events'
        ? {
            ...row,
            result: { ...row.result, events: [hotel] },
          }
        : row,
    );
    const withoutFlight = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: noFlightRows as never,
      plan: { ...threeDayPlan, slotCount: 1, windowLabel: 'Friday afternoon' },
    });

    expect(result.slotCount).toBe(0);
    expect(result.coverageComplete).toBe(true);
    expect(result.text).toContain('I couldn’t identify suitable 60-minute blocks');
    expect(result.text).not.toContain('Focus candidates (not availability-cleared)');
    expect(withoutFlight.slotCount).toBe(1);
  });

  it.each([
    {
      name: 'an opaque long event',
      stay: {
        eventId: 'opaque',
        calendar: 'Travel',
        calendarId: 'travel-calendar',
        summary: 'Berlin',
        start: '2026-10-10T06:00:00-07:00',
        end: '2026-10-17T02:00:00-07:00',
        blocksTime: true,
      },
    },
    {
      name: 'an unmatched calendar label',
      availabilityBusy: [{ start: threeDayStart, end: threeDayEnd, calendar: 'Travel' }],
      checked: ['Another travel calendar', 'Work', 'Holidays'],
    },
    {
      name: 'ambiguous duplicate calendar labels',
      checked: ['Travel', 'Travel', 'Work', 'Holidays'],
      extraEvents: [
        {
          eventId: 'transparent-other-calendar',
          calendar: 'Travel',
          calendarId: 'other-travel-calendar',
          summary: 'Transparent note',
          start: '2026-10-13T09:00:00-07:00',
          end: '2026-10-13T10:00:00-07:00',
          blocksTime: false,
        },
      ],
    },
    {
      name: 'incomplete event coverage',
      eventPage: { complete: false },
    },
  ])('keeps provider busy blocking for $name', (options) => {
    const result = weeklyCalendarPlanResult({
      timeMin: threeDayStart,
      timeMax: threeDayEnd,
      timeZone: 'America/Los_Angeles',
      evidence: stayEvidence(options) as never,
      plan: threeDayPlan,
    });

    expect(result.slotCount).toBe(0);
    expect(result.text).not.toContain('Focus candidates (not availability-cleared)');
    expect(result.text).toContain('I couldn’t identify suitable 60-minute blocks');
  });

  it('keeps the requested count, duration, window and meeting break constraints', () => {
    const plan = requestedCalendarPlanOptions(prompt);
    expect(plan).toEqual({
      focusMinutes: 60,
      slotCount: 2,
      breakMinutes: 15,
      meetingBufferMinutes: 15,
      workingDays: 3,
      windowLabel: 'the next 3 working days',
      includeWorkloadAssessment: false,
      includeTravelBuffers: false,
    });
    const end = '2026-10-15T07:00:00.000Z';
    const meeting = {
      eventId: 'morning',
      calendarId: 'Work',
      summary: 'Review',
      start: '2026-10-12T16:00:00Z',
      end: '2026-10-12T17:00:00Z',
      ownerResponse: 'accepted',
      location: '120 Example Street',
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
    expect(answer.text.match(/\(60m\)/g)).toHaveLength(2);
    expect(answer.text).toContain('the next 3 working days');
    expect(answer.text).toContain('before and after meetings');
    expect(answer.text).not.toContain('30-minute travel');
    expect(answer.text).not.toContain('Overloaded-day assessment');
    expect(answer.text).not.toContain('Overloaded-day estimate');
    expect(answer.text).not.toContain('Evening review');
    expect(answer.text).not.toContain('90 minutes');
    expect(answer.text).not.toMatch(/- Mon, Oct 12, (9|10):00 AM/);
    expect(answer.text).toContain('no calendar changes made');
  });

  it('bounds a dense conflict and source list while stating how many details were omitted', () => {
    const end = '2026-10-13T07:00:00.000Z';
    const events = Array.from({ length: 50 }, (_, index) => ({
      eventId: `meeting-${index + 1}`,
      calendarId: `calendar-${index + 1}`,
      calendar: `Calendar ${index + 1}`,
      summary: `Meeting ${index + 1}`,
      start: '2026-10-12T16:00:00Z',
      end: '2026-10-12T17:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
      links: [
        {
          type: 'calendar',
          url: `https://calendar.google.com/calendar/event?eid=event-${index + 1}`,
        },
      ],
    }));
    const rows = evidence({
      timeMin,
      timeMax: end,
      busy: [{ start: events[0]?.start, end: events[0]?.end }],
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin, timeMax: end },
          result: {
            events,
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const result = weeklyCalendarPlanResult({
      timeMin,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan: {
        focusMinutes: 60,
        slotCount: 2,
        breakMinutes: 15,
        meetingBufferMinutes: 15,
        windowLabel: 'the next working day',
        includeWorkloadAssessment: false,
        includeTravelBuffers: false,
      },
    });

    expect(result.text.length).toBeLessThan(6_000);
    expect(result.text).toContain('additional overlaps or possible duplicate listings omitted');
    expect(result.text).toContain('all were included in the planning check');
    expect(result.text).toContain('additional source links omitted from this brief');
    expect(result.text).toContain('calendar.google.com/calendar/event?eid=event-1');
    expect(result.text).not.toContain('event-50');
  });

  it('limits a working-day plan to its selected weekdays and separates all-day load from meetings', () => {
    const start = '2026-10-15T07:00:00.000Z'; // Thu 00:00 in Los Angeles
    const end = '2026-10-20T07:00:00.000Z'; // Tue 00:00, exclusive
    const allDayBusy = {
      eventId: 'all-day-travel-hold',
      calendarId: 'travel',
      summary: 'Travel hold',
      start: '2026-10-15',
      end: '2026-10-16',
      calendarTimeZone: 'America/Los_Angeles',
      allDay: true,
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const sportsA = {
      eventId: 'sports-a',
      calendarId: 'sports-one',
      summary: 'Alameda Soccer',
      start: '2026-10-16T17:00:00Z',
      end: '2026-10-16T18:00:00Z',
      location: 'Field 1',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const sportsB = {
      ...sportsA,
      eventId: 'sports-b',
      calendarId: 'sports-two',
    };
    const mondayA = {
      eventId: 'meeting-a',
      calendarId: 'work-one',
      summary: 'Project review',
      start: '2026-10-19T16:00:00Z',
      end: '2026-10-19T17:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const mondayB = {
      ...mondayA,
      eventId: 'meeting-b',
      calendarId: 'work-two',
      summary: 'Budget review',
    };
    const weekendA = {
      eventId: 'weekend-a',
      calendarId: 'weekend-one',
      summary: 'Weekend appointment',
      start: '2026-10-17T17:00:00Z',
      end: '2026-10-17T18:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const weekendB = {
      ...weekendA,
      eventId: 'weekend-b',
      calendarId: 'weekend-two',
      summary: 'Weekend presentation',
    };
    const rows = evidence({
      timeMin: start,
      timeMax: end,
      busy: [
        {
          start: '2026-10-15T07:00:00Z',
          end: '2026-10-16T07:00:00Z',
          calendar: 'Travel',
        },
      ],
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin: start, timeMax: end, maxResults: 50 },
          result: {
            events: [allDayBusy, sportsA, sportsB, mondayA, mondayB, weekendA, weekendB],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan: threeDayPlan,
    });

    expect(result.text).toContain('Possible duplicate listing: Alameda Soccer and Alameda Soccer');
    expect(result.text).not.toContain('Scheduling conflict: Alameda Soccer');
    expect(result.text).not.toContain('Possible overlap: Alameda Soccer');
    expect(result.text).toContain('Scheduling conflict: Project review and Budget review');
    expect(result.text).not.toContain('Sat, Oct 17');
    expect(result.text).not.toContain('Sun, Oct 18');
    expect(result.text).toContain(
      'All-day holds that still block focus time (not counted as meeting workload)',
    );
    expect(result.text).not.toContain('Overloaded-day estimate: Thu, Oct 15');
    expect(result.text).toContain('Travel hold');
    expect(result.slotCount).toBe(2);
  });

  it('keeps working-day selection on local civil dates across a DST fallback weekend', () => {
    const start = '2026-10-31T07:00:00.000Z'; // Sat 00:00 in Los Angeles
    const end = '2026-11-04T08:00:00.000Z'; // Wed 00:00 after fallback, exclusive
    const sundayA = {
      eventId: 'sunday-a',
      calendarId: 'sunday-one',
      summary: 'Sunday appointment',
      start: '2026-11-01T17:00:00Z',
      end: '2026-11-01T18:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const sundayB = {
      ...sundayA,
      eventId: 'sunday-b',
      calendarId: 'sunday-two',
      summary: 'Sunday review',
    };
    const mondayA = {
      eventId: 'monday-a',
      calendarId: 'monday-one',
      summary: 'Monday review',
      start: '2026-11-02T18:00:00Z',
      end: '2026-11-02T19:00:00Z',
      ownerResponse: 'accepted',
      blocksTime: true,
    };
    const mondayB = {
      ...mondayA,
      eventId: 'monday-b',
      calendarId: 'monday-two',
      summary: 'Monday planning',
    };
    const rows = evidence({
      timeMin: start,
      timeMax: end,
      pages: [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin: start, timeMax: end, maxResults: 50 },
          result: {
            events: [sundayA, sundayB, mondayA, mondayB],
            complete: true,
            calendarRosterComplete: true,
            unavailable: [],
          },
        },
      ],
    });
    const result = weeklyCalendarPlanResult({
      timeMin: start,
      timeMax: end,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
      plan: {
        focusMinutes: 60,
        slotCount: 2,
        breakMinutes: 15,
        windowLabel: 'the next 2 working days',
        workingDays: 2,
      },
    });

    expect(result.text).not.toContain('Sunday');
    expect(result.text).toContain('Scheduling conflict: Monday review and Monday planning');
    expect(result.text).toContain('Mon, Nov 2');
    expect(result.text).toContain('Tue, Nov 3');
    expect(result.slotCount).toBe(2);
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

describe('exact-ID event-list recovery of missing free/busy', () => {
  function recoveryEvidence(events: Record<string, unknown>[] = []) {
    return [
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin, timeMax },
        result: {
          busy: [],
          complete: false,
          unavailable: ['Shared'],
          calendarsChecked: ['Shared'],
          calendarRosterComplete: true,
          calendarIdsRequested: ['shared-id'],
          coverageWindow: { timeMin, timeMax },
          calendarCoverage: [
            {
              calendarId: 'shared-id',
              name: 'Shared',
              status: 'unavailable',
              reason: 'provider-error',
            },
          ],
        },
      },
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        args: { timeMin, timeMax },
        result: {
          events,
          complete: true,
          unavailable: [],
          calendarRosterComplete: true,
          calendarsSearchedIds: ['shared-id'],
          calendarsResolved: [{ id: 'shared-id', name: 'Shared', timeZone: 'UTC' }],
        },
      },
    ] as const;
  }
  const project = (rows: ReturnType<typeof recoveryEvidence>) =>
    weeklyCalendarPlanResult({
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      evidence: rows as never,
    });
  it('recovers a full exact-window calendar listing, preserving blocking and transparent intervals', () => {
    const events = [
      {
        calendarId: 'shared-id',
        calendar: 'Shared',
        summary: 'Meeting',
        start: '2026-10-12T09:00:00-07:00',
        end: '2026-10-12T10:30:00-07:00',
        blocksTime: true,
      },
      {
        calendarId: 'shared-id',
        calendar: 'Shared',
        summary: 'Reference',
        start: '2026-10-13',
        end: '2026-10-14',
        calendarTimeZone: 'UTC',
        allDay: true,
        blocksTime: false,
      },
    ];
    const result = project(recoveryEvidence(events));
    expect(result.coverageComplete).toBe(true);
    expect(result.slotCount).toBe(3);
    expect(result.text).toContain('event-list fallback');
    expect(result.text).not.toContain('Mon, Oct 12, 9:00 AM–10:30 AM');
    expect(result.text).toContain('| Tue, Oct 13, 9:00 AM–10:30 AM');
  });
  it('preserves opaque source-zone all-day holds, including their next-day exclusive end', () => {
    const result = project(
      recoveryEvidence([
        {
          calendarId: 'shared-id',
          calendar: 'Shared',
          summary: 'Opaque hold',
          start: '2026-10-13',
          end: '2026-10-14',
          calendarTimeZone: 'UTC',
          allDay: true,
          blocksTime: true,
        },
      ]),
    );
    expect(result.coverageComplete).toBe(true);
    expect(result.text).not.toContain('Tue, Oct 13, 9:00 AM–10:30 AM');
    expect(result.text).toContain('Opaque hold');
    expect(result.text).toContain('do not establish continuous meeting attendance');
  });
  it('uses exact IDs despite duplicate labels and retains blocking rows across copied occurrence identities', () => {
    const rows = recoveryEvidence([
      {
        calendarId: 'shared-id',
        calendar: 'Shared',
        iCalUID: 'copied-occurrence',
        eventId: 'one',
        summary: 'Physical meeting',
        location: 'Office',
        start: '2026-10-12T09:00:00-07:00',
        end: '2026-10-12T10:30:00-07:00',
        blocksTime: true,
      },
      {
        calendarId: 'second-id',
        calendar: 'Shared',
        iCalUID: 'copied-occurrence',
        eventId: 'two',
        summary: 'Copy',
        start: '2026-10-12T09:00:00-07:00',
        end: '2026-10-12T10:30:00-07:00',
        blocksTime: false,
      },
    ]);
    const availability = rows[0].result as Record<string, unknown>;
    availability.calendarIdsRequested = ['shared-id', 'second-id'];
    availability.calendarCoverage = [
      { calendarId: 'shared-id', name: 'Shared', status: 'unavailable' },
      { calendarId: 'second-id', name: 'Shared', status: 'unavailable' },
    ];
    const listing = rows[1].result as Record<string, unknown>;
    listing.calendarsSearchedIds = ['shared-id', 'second-id'];
    listing.calendarsResolved = [
      { id: 'shared-id', name: 'Shared' },
      { id: 'second-id', name: 'Shared' },
    ];
    const result = project(rows);
    expect(result.coverageComplete).toBe(true);
    expect(result.text).not.toContain('Mon, Oct 12, 9:00 AM–10:30 AM');
    expect(result.text).toContain('30-minute travel buffer');
  });

  it('retains every returned provider busy interval when coverage is recovered', () => {
    const rows = recoveryEvidence();
    (rows[0].result as Record<string, unknown>).busy = [
      { start: timeMin, end: timeMax, calendar: 'Shared', calendarId: 'shared-id' },
    ];
    const result = project(rows);
    expect(result.coverageComplete).toBe(true);
    expect(result.slotCount).toBe(0);
    expect(result.text).toContain('I couldn’t identify suitable');
  });

  it('recovers complete bounded pagination but rejects a gap or failed earlier page', () => {
    const rows = recoveryEvidence();
    const first = {
      ...rows[1],
      result: { ...rows[1].result, complete: false, nextPageToken: 'page-2' },
    };
    const last = { ...rows[1], args: { ...rows[1].args, pageToken: 'page-2' } };
    const render = () =>
      weeklyCalendarPlanResult({
        timeMin,
        timeMax,
        timeZone: 'America/Los_Angeles',
        evidence: [rows[0], first, last] as never,
      });
    expect(render().coverageComplete).toBe(true);
    last.args.pageToken = 'wrong-page';
    expect(render().coverageComplete).toBe(false);
    last.args.pageToken = 'page-2';
    (first.result as Record<string, unknown>).unavailable = ['Shared'];
    expect(render().coverageComplete).toBe(false);
  });

  it('does not offer focus times when malformed provider data has no usable busy rows', () => {
    const rows = recoveryEvidence();
    (rows[0].result as Record<string, unknown>).calendarCoverage = [
      { calendarId: 'shared-id', name: 'Shared', status: 'malformed' },
    ];
    const result = project(rows);
    expect(result.coverageComplete).toBe(false);
    expect(result.slotCount).toBe(0);
    expect(result.text).toContain('usable free/busy intervals were unavailable');
  });

  it('never recovers from labels alone, an altered window, partial roster/pages or malformed source semantics', () => {
    const mutations: Array<(rows: ReturnType<typeof recoveryEvidence>) => void> = [
      (rows) => {
        delete (rows[0].result as Record<string, unknown>).calendarCoverage;
      },
      (rows) => {
        (rows[0].result as Record<string, unknown>).coverageWindow = {
          timeMin: '2026-10-11T07:00:00.000Z',
          timeMax,
        };
      },
      (rows) => {
        (rows[0].result as Record<string, unknown>).calendarRosterComplete = false;
      },
      (rows) => {
        (rows[0].result as Record<string, unknown>).calendarCoverage = [
          { calendarId: 'shared-id', name: 'Shared', status: 'malformed' },
        ];
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).complete = false;
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).nextPageToken = 'remaining';
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).calendarsSearchedIds = ['another-id'];
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).calendarsResolved = [
          { id: 'another-id', name: 'Shared' },
        ];
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).events = [
          {
            calendarId: 'shared-id',
            start: '2026-10-13',
            end: '2026-10-14',
            allDay: true,
            blocksTime: true,
          },
        ];
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).events = [
          {
            calendarId: 'shared-id',
            start: '2026-10-13T09:00:00',
            end: '2026-10-13T10:00:00',
            blocksTime: true,
          },
        ];
      },
      (rows) => {
        (rows[1].result as Record<string, unknown>).events = [
          { calendarId: 'shared-id', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' },
        ];
      },
      (rows) => {
        (rows[0].result as Record<string, unknown>).busy = [{ start: 'broken', end: 'broken' }];
      },
    ];
    for (const mutate of mutations) {
      const rows = recoveryEvidence();
      mutate(rows);
      expect(project(rows).coverageComplete).toBe(false);
      expect(project(rows).text).not.toContain('event-list fallback');
    }
  });
});
