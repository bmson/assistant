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
    expect(JSON.stringify(cards)).not.toContain('needsAction');
    expect(JSON.stringify(cards)).not.toContain('accepted');
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
});
