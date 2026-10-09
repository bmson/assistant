import { describe, expect, it } from 'vitest';
import { agendaSection, briefingMarkdown } from './briefing-card.js';
import type { PersonalReadRequest } from './read-intent.js';
import { verifiedReadResponse } from './response-contract.js';

function request(timeZone = 'UTC'): PersonalReadRequest {
  return {
    kind: 'calendar',
    queryTerms: [],
    firstToolName: 'calendar.list_events',
    requiresThreadRead: false,
    timeZone,
    timeWindow: {
      label: 'this week',
      timeMin: '2026-09-21T00:00:00.000Z',
      timeMax: '2026-09-28T00:00:00.000Z',
    },
  };
}

function evidence(events: unknown[], complete = true) {
  return [
    {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: {
        timeMin: '2026-09-21T00:00:00.000Z',
        timeMax: '2026-09-28T00:00:00.000Z',
      },
      result: { complete, calendarsSearched: ['Work'], events },
    },
  ];
}

describe('R15 retrieved versus displayed calendar coverage', () => {
  it.each([13, 20, 21, 50])(
    'retains every retrieved event in the full %i-event agenda',
    (count) => {
      const events = Array.from({ length: count }, (_, index) => ({
        eventId: `event-${index}`,
        calendarId: 'work',
        calendar: 'Work',
        summary: `Appointment ${String(index).padStart(3, '0')}`,
        start: '2026-09-22T09:00:00Z',
        end: '2026-09-22T10:00:00Z',
        location: index === count - 1 ? 'Only important destination' : '',
        allDay: false,
      }));
      const text = verifiedReadResponse(request(), evidence(events));
      expect(text.match(/^- \*\*/gm)).toHaveLength(count);
      for (const event of events) expect(text).toContain(event.summary);
      expect(text).toContain('Only important destination');
      expect(text.indexOf(events[0]?.summary ?? '')).toBeLessThan(
        text.indexOf(events[count - 1]?.summary ?? ''),
      );
    },
  );

  it.each([13, 20, 21, 50])(
    'labels omissions and keeps late important items in a %i-event preview',
    (count) => {
      const events = Array.from({ length: count }, (_, index) => ({
        eventId: `event-${index}`,
        calendar: 'Work',
        summary: `Appointment ${String(index).padStart(3, '0')}`,
        start: '2026-09-22T09:00:00Z',
        end: '2026-09-22T10:00:00Z',
        allDay: false,
      }));
      const salient = events[count - 1];
      const conflict = events[count - 2];
      if (!salient || !conflict) throw new Error('Missing important fixtures');
      const section = agendaSection({
        events,
        complete: true,
        salient: [{ event: salient, score: 5, reasons: ['travel'] }],
        conflicts: [
          {
            a: [events[0]],
            b: [conflict],
            overlapStart: conflict.start,
            overlapEnd: conflict.end,
          } as never,
        ],
        timeZone: 'UTC',
        now: new Date('2026-09-22T08:00:00Z'),
      });
      expect(section).toMatchObject({
        type: 'agenda',
        complete: true,
        title: `Schedule (10 of ${count} events)`,
        omittedCount: count - 10,
      });
      if (section?.type !== 'agenda') throw new Error('Missing agenda');
      expect(section.items).toHaveLength(10);
      expect(section.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: salient.summary, flag: 'salient' }),
          expect.objectContaining({ title: conflict.summary, flag: 'conflict' }),
        ]),
      );
      expect(briefingMarkdown('Briefing', [section])).toContain(
        `${count - 10} other retrieved events are omitted`,
      );
    },
  );

  it.each(['Etc/GMT-12', 'Etc/GMT-13', 'Etc/GMT-14', 'Etc/GMT+12'])(
    'preserves civil dates and a multi-day exclusive end in %s',
    (timeZone) => {
      const event = {
        eventId: 'all-day',
        calendar: 'Work',
        summary: 'Multi-day offsite',
        start: '2026-09-22',
        end: '2026-09-24',
        allDay: true,
      };
      const text = verifiedReadResponse(request(timeZone), evidence([event]));
      expect(text).toContain('Tue 22 Sept · All day');
      expect(text).toContain('through Wednesday, September 23, 2026');
      expect(text).not.toMatch(/21 Sept|September 21|24 Sept|September 24/);
      const section = agendaSection({
        events: [event],
        complete: true,
        salient: [],
        conflicts: [],
        timeZone,
        now: new Date('2026-09-21T23:00:00Z'),
      });
      expect(section).toMatchObject({
        items: [{ day: timeZone === 'Etc/GMT+12' ? 'Tomorrow' : 'Today', time: 'All day' }],
      });
    },
  );

  it('keeps an empty partial calendar distinct from an empty complete calendar', () => {
    const partial = verifiedReadResponse(request(), evidence([], false));
    expect(partial).toContain('checked subset');
    expect(partial).toContain('does not establish an empty calendar');
    expect(partial).not.toContain('Nothing on the calendar');
    expect(verifiedReadResponse(request(), evidence([], true))).toContain(
      'Nothing on the calendar',
    );
  });
});
