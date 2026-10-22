import { describe, expect, it } from 'vitest';
import { detectPersonalReadRequest } from './read-intent.js';
import { responseCardsForFinal } from './response-cards.js';

const ownerText = 'What does my calendar look like tomorrow?';
const request = detectPersonalReadRequest([{ role: 'user', content: ownerText }], {
  now: new Date('2026-10-22T18:00:00Z'),
  timeZone: 'America/Los_Angeles',
});
if (!request) throw new Error('Expected calendar request');
const event = (index: number) => ({
  eventId: `row-${index}`,
  calendarId: 'work',
  calendar: 'Work',
  summary: `Review ${index}`,
  start: `2026-10-23T${String(8 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}:00-07:00`,
  end: `2026-10-23T${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}:00-07:00`,
  ownerResponse: index === 5 ? 'needsAction' : 'accepted',
  ownerParticipation: {
    status: index === 5 ? 'needsAction' : 'accepted',
    identityVerified: true,
    basis: 'attendee-email',
  },
});
const evidence = (events: unknown[], overrides: Record<string, unknown> = {}) => ({
  toolName: 'calendar.list_events',
  status: 'succeeded',
  fromCurrentTask: true,
  args: { timeMin: request?.timeWindow?.timeMin, timeMax: request?.timeWindow?.timeMax },
  result: { complete: true, calendarsSearched: ['Work'], events },
  ...overrides,
});

describe('deterministic calendar agenda integration', () => {
  it('projects ordinary and briefing evidence into one primary briefing with all thirteen rows', () => {
    const cards = responseCardsForFinal({
      evidence: [evidence(Array.from({ length: 13 }, (_, index) => event(index)))],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'briefing',
      presentation: 'calendar-agenda',
      accompaniesProse: false,
      complete: true,
      lead: '13 events from Work.',
    });
    const sections = cards[0]?.sections as { type: string; items: unknown[] }[];
    expect(sections.find((s) => s.type === 'agenda')?.items).toHaveLength(13);
    expect(JSON.stringify(cards)).toContain('Needs response');
    const visibleAgenda = JSON.stringify(
      sections
        .find((section) => section.type === 'agenda')
        ?.items.map((item) => {
          const row = item as Record<string, unknown>;
          return { title: row.title, time: row.time, note: row.note };
        }),
    );
    expect(visibleAgenda).not.toContain('needsAction');
    expect(visibleAgenda).not.toContain('accepted');
  });
  it('does not turn prior-task events or failed results into a current agenda', () => {
    const cards = responseCardsForFinal({
      evidence: [evidence([event(1)], { fromCurrentTask: false }), evidence([])],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards[0]?.lead).toContain('No events');
    expect(JSON.stringify(cards)).not.toContain('Review 1');
  });
  it('never presents unscoped results as the requested named calendar', () => {
    const cards = responseCardsForFinal({
      evidence: [evidence([event(1)])],
      readRequest: { ...request, calendarScope: { name: 'Zendesk' } },
      requestText: 'Show my Zendesk calendar tomorrow',
    });
    expect(JSON.stringify(cards)).not.toContain('Review 1');
    expect(cards[0]?.lead).toContain('Couldn’t resolve Zendesk');
    expect(cards[0]?.complete).toBe(false);
  });

  it('honors an explicit request to omit overlap analysis', () => {
    const ownerText = 'Show my calendar tomorrow without checking overlaps';
    const readRequest = detectPersonalReadRequest([{ role: 'user', content: ownerText }], {
      now: new Date('2026-10-22T18:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(readRequest?.includeCalendarOverlapSummary).toBe(false);
    const cards = responseCardsForFinal({
      evidence: [
        {
          ...evidence([
            { ...event(1), start: '2026-10-23T09:00:00-07:00', end: '2026-10-23T10:00:00-07:00' },
            { ...event(2), start: '2026-10-23T09:30:00-07:00', end: '2026-10-23T10:30:00-07:00' },
          ]),
          args: {
            timeMin: readRequest?.timeWindow?.timeMin,
            timeMax: readRequest?.timeWindow?.timeMax,
          },
        },
      ],
      readRequest,
      requestText: ownerText,
    });
    const sections = cards.flatMap((card) => card.sections ?? []) as Array<{ type?: string }>;
    expect(sections.some((section) => section.type === 'attention')).toBe(false);
  });
  it('keeps a specific event time answer in the existing prose-and-source format', () => {
    const cards = responseCardsForFinal({
      evidence: [evidence([event(1)])],
      readRequest: detectPersonalReadRequest([
        { role: 'user', content: 'What time is my Design review tomorrow?' },
      ]),
      requestText: 'What time is my Design review tomorrow?',
    });
    expect(cards.map((card) => card.kind)).toEqual(['calendar-event']);
  });
  it('retains source civil dates for an all-day event without a source time zone', () => {
    const cards = responseCardsForFinal({
      evidence: [evidence([{ ...event(1), start: '2026-10-23', end: '2026-10-25', allDay: true }])],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards[0]).toMatchObject({ complete: false, date: 'Dates not verified' });
    const payload = JSON.stringify(cards);
    expect(payload).toContain('Source date: 2026-10-23');
    expect(payload).toContain('ends 2026-10-25 (exclusive)');
    expect(payload).toContain('Calendar time zone unavailable');
  });
  it('keeps unavailable calendar names and reasons visible without claiming an empty day', () => {
    const cards = responseCardsForFinal({
      evidence: [
        {
          ...evidence([]),
          result: {
            complete: false,
            calendarsSearched: ['Personal'],
            events: [],
            unavailable: [{ calendar: 'Work', reason: 'Permission denied' }],
          },
        },
      ],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards[0]).toMatchObject({ complete: false });
    expect(cards[0]?.lead).toContain('checked subset');
    const payload = JSON.stringify(cards);
    expect(payload).toContain('Calendars not checked');
    expect(payload).toContain('Work');
    expect(payload).toContain('Permission denied');
    expect(payload).not.toContain('No events on');
  });
});
