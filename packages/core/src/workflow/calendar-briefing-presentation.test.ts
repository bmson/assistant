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
const evidence = (events: Record<string, unknown>[], complete = true) => [
  {
    toolName: 'calendar.list_events',
    status: 'succeeded',
    args: request.timeWindow,
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
    expect(response).toContain('Fri 16 Oct · All day');
    expect(response).toContain('source date 2026-10-16 (Asia/Tokyo)');
    expect(response).not.toContain('Thu 15 Oct · All day');
    expect(calendarResponseCards(evidence([losAngeles]), request)).toEqual([]);
    expect(verifiedReadResponse(request, evidence([losAngeles]))).not.toContain('Payday');
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

  it('counts undisplayed overlap pairs independently of the shared attendance caveat', () => {
    const events = Array.from({ length: 4 }, (_, index) => ({
      ...timed,
      eventId: `event-${index}`,
      summary: `Appointment ${index}`,
    }));
    const response = verifiedReadResponse(request, evidence(events));
    expect(response.match(/Possible overlap:/g)).toHaveLength(3);
    expect(response).toContain('3 additional overlapping pairs');
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
