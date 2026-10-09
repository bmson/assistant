import { describe, expect, it } from 'vitest';
import { agendaSection, briefingMarkdown, listSection, weatherSection } from './briefing-card.js';

const timeZone = 'America/Los_Angeles';
const now = new Date('2026-09-22T14:00:00Z'); // 07:00 local

describe('agendaSection', () => {
  it.each(['Pacific/Kiritimati', 'Pacific/Tongatapu', 'Etc/GMT+12'])(
    'keeps an all-day civil date on its own day in %s',
    (zone) => {
      const instant = new Date('2026-09-22T12:00:00Z');
      const section = agendaSection({
        events: [
          {
            summary: 'Offsite',
            start: '2026-09-22',
            end: '2026-09-23',
            calendar: 'Work',
            allDay: true,
          },
        ],
        complete: true,
        conflicts: [],
        salient: [],
        timeZone: zone,
        now: instant,
      });
      const label = zone === 'Etc/GMT+12' ? 'Today' : 'Tue, Sep 22';
      expect(section).toMatchObject({ items: [{ day: label, time: 'All day' }] });
    },
  );
  it('keeps a salient event beyond the preview boundary and reports display omissions', () => {
    const events = Array.from({ length: 21 }, (_, i) => ({
      eventId: `e${i}`,
      summary: `Event ${i}`,
      start: '2026-09-22T16:00:00Z',
      end: '2026-09-22T17:00:00Z',
      calendar: 'Work',
      allDay: false,
    }));
    const last = events[20];
    const section = agendaSection({
      events,
      complete: true,
      conflicts: [],
      salient: [{ event: last!, score: 5, reasons: ['travel'] }],
      timeZone,
      now,
    });
    expect(section).toMatchObject({
      complete: true,
      omittedCount: 11,
      title: 'Schedule (10 of 21 events)',
    });
    expect(
      section && 'items' in section && section.items.some((item) => item.title === 'Event 20'),
    ).toBe(true);
    expect(briefingMarkdown('Your briefing', [section!])).toContain(
      '11 other retrieved events are omitted',
    );
  });
  it('labels days and clock ranges in the owner zone and flags conflicts and salient events', () => {
    const dentist = {
      eventId: 'd',
      summary: 'Dentist',
      start: '2026-09-22T16:30:00Z',
      end: '2026-09-22T17:30:00Z',
      calendar: 'Home',
      allDay: false,
      location: 'Laugavegur 12',
    };
    const interview = { ...dentist, eventId: 'i', summary: 'Interview', location: undefined };
    const flight = {
      eventId: 'f',
      summary: 'Flight to Denver',
      start: '2026-09-23T15:00:00Z',
      end: '2026-09-23T18:00:00Z',
      calendar: 'Home',
      allDay: false,
    };
    const offsite = {
      summary: 'Offsite',
      start: '2026-09-23',
      end: '2026-09-24',
      calendar: 'Work',
      allDay: true,
    };
    const section = agendaSection({
      events: [dentist, interview, flight, offsite],
      complete: true,
      conflicts: [
        {
          a: [dentist],
          b: [interview],
          overlapStart: dentist.start,
          overlapEnd: dentist.end,
        } as never,
      ],
      salient: [{ event: flight, score: 3, reasons: ['somewhere you have to travel to'] }],
      timeZone,
      now,
    });
    expect(section).toMatchObject({
      type: 'agenda',
      items: [
        {
          day: 'Today',
          time: '9:30 AM – 10:30 AM',
          title: 'Dentist',
          location: 'Laugavegur 12',
          flag: 'conflict',
        },
        { day: 'Today', title: 'Interview', flag: 'conflict' },
        {
          day: 'Tomorrow',
          time: '8:00 AM – 11:00 AM',
          flag: 'salient',
          note: 'somewhere you have to travel to',
        },
        { day: 'Tomorrow', time: 'All day', title: 'Offsite' },
      ],
    });
  });

  it('is absent for an empty calendar', () => {
    expect(
      agendaSection({ events: [], complete: true, conflicts: [], salient: [], timeZone, now }),
    ).toBeUndefined();
  });
});

describe('weatherSection', () => {
  it('reduces the ambient card to one line and mentions only a plannable rain chance', () => {
    const card = {
      kind: 'weather',
      location: 'San Francisco',
      temperature: '18°C',
      condition: 'overcast',
      symbol: 'cloudy',
      current: { lowC: 14, highC: 21, precipPct: 10 },
    };
    expect(weatherSection(card)).toEqual({
      type: 'weather',
      title: 'Weather',
      location: 'San Francisco',
      temperature: '18°C',
      condition: 'overcast',
      symbol: 'cloudy',
      range: '14–21°C',
    });
    expect(weatherSection({ ...card, current: { precipPct: 60 } })).toMatchObject({
      rain: '60% chance of rain',
    });
    expect(weatherSection(undefined)).toBeUndefined();
  });
});

describe('briefingMarkdown', () => {
  it('leads with the lead, then one bold label and list per section', () => {
    const text = briefingMarkdown('Clear morning; one approval is waiting.', [
      {
        type: 'agenda',
        title: 'Schedule',
        complete: false,
        items: [{ day: 'Today', time: '9:30 AM – 10:30 AM', title: 'Dentist', location: 'Clinic' }],
      },
      listSection('attention', 'Needs you', [
        { title: 'Fetch public web page', meta: 'A128DY' },
        { title: '   ' },
      ]) as never,
    ]);
    expect(text).toBe(
      [
        'Clear morning; one approval is waiting.',
        '**Today**\n- **9:30 AM – 10:30 AM** — Dentist — Clinic',
        'Some calendars could not be read, so this may be incomplete.',
        '**Needs you**\n- **A128DY** — Fetch public web page',
      ].join('\n\n'),
    );
  });

  it('drops empty lists entirely', () => {
    expect(listSection('mail', 'Mail worth reading', [{ title: '' }])).toBeUndefined();
  });
});
