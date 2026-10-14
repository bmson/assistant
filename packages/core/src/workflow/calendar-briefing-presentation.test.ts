import { describe, expect, it } from 'vitest';
import { calendarSourceInterval, calendarWindowMembership } from './calendar-read-window.js';
import type { PersonalReadRequest } from './read-intent.js';
import { calendarResponseCards } from './response-cards.js';
import {
  enforceResponseContract,
  groundReadDraft,
  verifiedReadResponse,
} from './response-contract.js';

const request: PersonalReadRequest = {
  kind: 'calendar',
  queryTerms: [],
  requiresThreadRead: false,
  firstToolName: 'calendar.list_events',
  includeCalendarBriefing: true,
  includeCalendarOverlapSummary: true,
  timeZone: 'America/Los_Angeles',
  timeWindow: {
    label: 'tomorrow',
    timeMin: '2026-10-15T07:00:00Z',
    timeMax: '2026-10-16T07:00:00Z',
  },
};
const link = (id: string) => [
  { type: 'calendar', label: 'Open event', url: `https://calendar.google.com/event?eid=${id}` },
];
const timed = {
  eventId: 'review',
  calendar: 'Work',
  summary: 'Project review',
  start: '2026-10-15T09:00:00-07:00',
  end: '2026-10-15T10:00:00-07:00',
  links: link('review'),
};
const floating = {
  eventId: 'pay',
  calendar: 'Personal',
  summary: 'Payday',
  start: '2026-10-16',
  end: '2026-10-17',
  allDay: true,
  links: link('pay'),
};
const evidence = (
  events: Record<string, unknown>[],
  complete = true,
  readRequest: PersonalReadRequest = request,
) => [
  {
    toolName: 'calendar.list_events',
    status: 'succeeded',
    args: readRequest.timeWindow,
    result: {
      events,
      complete,
      calendarRosterComplete: true,
      calendarsSearched: ['Work', 'Personal'],
      unavailable: [],
    },
  },
];

describe('calendar day and practical briefing fidelity', () => {
  it('keeps unknown-zone floating records dated and outside the confirmed local agenda/cards', () => {
    const rows = evidence([timed, floating]);
    const response = verifiedReadResponse(request, rows);
    expect(response).toContain('Thu 15 Oct (America/Los_Angeles)');
    expect(response).toContain('**09:00–10:00** — Project review');
    expect(response).toContain('not confirmed for the requested local day');
    expect(response).toContain('Payday — source date 2026-10-16; calendar time zone unavailable');
    expect(response).toContain('event?eid=pay');
    expect(response).not.toContain('**All day** — Payday');
    expect(calendarResponseCards(rows, request).map((card) => card.title)).toEqual([
      'Project review',
    ]);
    expect(
      groundReadDraft('Tomorrow: Project review at 09:00, plus all-day Payday.', request, rows)
        .grounded,
    ).toBe(false);
  });

  it('uses the actual source zone to classify cross-zone all-day dates without changing their civil dates', () => {
    const tokyo = { ...floating, calendarTimeZone: 'Asia/Tokyo' };
    const losAngeles = { ...floating, calendarTimeZone: 'America/Los_Angeles' };
    expect(calendarWindowMembership(tokyo, request)).toBe('confirmed');
    expect(calendarSourceInterval(tokyo)).toEqual({
      start: Date.parse('2026-10-15T15:00:00Z'),
      end: Date.parse('2026-10-16T15:00:00Z'),
    });
    expect(calendarWindowMembership(losAngeles, request)).toBe('outside');
    const response = verifiedReadResponse(request, evidence([tokyo]));
    expect(response).toContain(
      'Thu 15 Oct 8:00 AM–Fri 16 Oct 12:00 AM (source all-day 2026-10-16 (Asia/Tokyo))',
    );
    expect(response).not.toContain('Thu 15 Oct · All day');
    expect(calendarResponseCards(evidence([losAngeles]), request)).toEqual([]);
    expect(verifiedReadResponse(request, evidence([losAngeles]))).not.toContain('Payday');
  });

  it('renders UTC and Berlin all-day entries by their local-day intersection and source dates', () => {
    const utc = {
      ...floating,
      eventId: 'utc-day',
      summary: 'UTC day entry',
      calendarTimeZone: 'UTC',
    };
    const berlin = {
      ...floating,
      eventId: 'berlin-day',
      summary: 'Berlin day entry',
      calendarTimeZone: 'Europe/Berlin',
    };
    const response = verifiedReadResponse(request, evidence([utc, berlin]));

    expect(response).toContain(
      'Thu 15 Oct 5:00 PM–Fri 16 Oct 12:00 AM (source all-day 2026-10-16 (UTC))',
    );
    expect(response).toContain(
      'Thu 15 Oct 3:00 PM–Fri 16 Oct 12:00 AM (source all-day 2026-10-16 (Europe/Berlin))',
    );
    expect(response).not.toContain('Fri 16 Oct · All day');
    expect(response).toContain('(Personal)');
  });

  it('handles exclusive ends and daylight-saving source civil midnight correctly', () => {
    expect(
      calendarSourceInterval({
        start: '2026-11-01',
        end: '2026-11-02',
        calendarTimeZone: 'America/Los_Angeles',
      }),
    ).toEqual({
      start: Date.parse('2026-11-01T07:00:00Z'),
      end: Date.parse('2026-11-02T08:00:00Z'),
    });
    expect(
      calendarSourceInterval({ ...floating, calendarTimeZone: 'invented/zone' }),
    ).toBeUndefined();
  });

  it('retains all confirmed events while shortening ongoing spans and repeated overlap caveats', () => {
    const stay = {
      ...timed,
      eventId: 'stay',
      summary: 'Hotel stay',
      start: '2026-10-10T06:00:00-07:00',
      end: '2026-10-17T02:00:00-07:00',
    };
    const response = verifiedReadResponse(request, evidence([stay, timed]));
    expect(response).toContain('**Ongoing through Sat 17 Oct 02:00** — Hotel stay');
    expect(response).toContain('Possible overlap: **Hotel stay** and **Project review**');
    expect(response).toContain('do not establish that you must attend both');
    expect(response).not.toContain('Sat, Oct 10');
  });

  it('names additional overlap pairs without repeating the shared attendance caveat', () => {
    const events = Array.from({ length: 4 }, (_, index) => ({
      ...timed,
      eventId: `event-${index}`,
      summary: `Appointment ${index}`,
    }));
    const response = verifiedReadResponse(request, evidence(events));
    expect(response.match(/Possible overlap:/g)).toHaveLength(3);
    expect(response).toContain(
      'Additional overlapping pairs: **Appointment 1** and **Appointment 2**; **Appointment 1** and **Appointment 3**; **Appointment 2** and **Appointment 3**.',
    );
    expect(response).not.toContain('additional overlapping pairs were found');
    expect(response.match(/do not establish that you must attend both/g)).toHaveLength(1);
  });

  it('dates events in short windows that cross local midnight', () => {
    const overnightRequest: PersonalReadRequest = {
      ...request,
      timeWindow: {
        label: 'overnight',
        timeMin: '2026-10-16T06:00:00Z', // Thu 15 Oct, 23:00 in Los Angeles
        timeMax: '2026-10-16T08:00:00Z', // Fri 16 Oct, 01:00; exclusive
      },
    };
    const afterMidnight = {
      ...timed,
      eventId: 'after-midnight',
      summary: 'Overnight review',
      start: '2026-10-16T00:30:00-07:00',
      end: '2026-10-16T00:45:00-07:00',
    };
    const response = verifiedReadResponse(
      overnightRequest,
      evidence([afterMidnight], true, overnightRequest),
    );
    expect(response).toContain('**Fri 16 Oct · 00:30–00:45** — Overnight review');
    expect(response).not.toContain('Thu 15 Oct (America/Los_Angeles)');
  });

  it('bounds additional overlap names for a full 50-event result and reports omissions', () => {
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...timed,
      eventId: `appointment-${index}`,
      summary: `Appointment ${index}`,
    }));
    const response = verifiedReadResponse(request, evidence(events));
    expect(response.match(/Possible overlap:/g)).toHaveLength(3);
    expect(response).toContain(
      'Additional overlapping pairs: **Appointment 0** and **Appointment 4**; **Appointment 0** and **Appointment 5**; **Appointment 0** and **Appointment 6**; 1,219 more not listed.',
    );
    expect(response).not.toContain('Appointment 49**');
    expect(response.match(/do not establish that you must attend both/g)).toHaveLength(1);
  });

  it('checks appended practical advice without permitting fake free-time or executed actions', () => {
    const rows = evidence([timed]);
    const projection = verifiedReadResponse(request, rows);
    const opts = {
      readRequest: request,
      groundingCorpus: 'Review preparation before summarizing.',
    };
    const useful = `${projection}\n\nNext step: Review preparation for Project review.`;
    expect(enforceResponseContract(useful, rows, opts)).toMatchObject({
      text: useful,
      blocked: false,
    });
    for (const suggestion of [
      'Your afternoon is free.',
      'I cancelled Project review.',
      'Project review is at 15:00.',
      'Project review is at Imaginary Hall.',
      'Prepare for your yoga session tomorrow.',
    ]) {
      expect(
        enforceResponseContract(`${projection}\n\nNext step: ${suggestion}`, rows, opts).text,
      ).not.toContain(`Next step: ${suggestion}`);
    }
  });

  it('keeps partial coverage explicit and does not infer working hours or free blocks', () => {
    const response = verifiedReadResponse(request, evidence([timed], false));
    expect(response).toContain('coverage was incomplete');
    expect(response).not.toMatch(/free|working hours|09:00–17:00/i);
  });
});
