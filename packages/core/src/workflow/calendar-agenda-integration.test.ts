import { describe, expect, it } from 'vitest';
import { calendarAgendaSummary } from './calendar-agenda.js';
import { detectPersonalReadRequest } from './read-intent.js';
import { calendarResponseCards, responseCardsForFinal } from './response-cards.js';

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
  it('shows a differently named cross-calendar game once and only one overlap with a gala', () => {
    const family = {
      calendarId: 'family',
      calendar: 'Family',
      eventId: 'family-game',
      summary: '⚽ United v Palo Alto (5:10PM)',
      start: '2026-10-23T16:25:00-07:00',
      end: '2026-10-23T18:30:00-07:00',
      allDay: false,
      blocksTime: true,
      location:
        'Crocker Amazon Soccer Fields, soccer field & Parking lot, 785 Moscow St, San Francisco, CA 94112, USA',
    };
    const team = {
      ...family,
      calendarId: 'soccer',
      calendar: 'SF United Soccer',
      eventId: 'team-game',
      summary: '26/27 U13B Azul vs Palo Alto SC 13/14B Gold',
      start: '2026-10-23T17:10:00-07:00',
      location: 'Crocker Amazon\n1669 Geneva Avenue, San Francisco, CA 94134',
    };
    const gala = {
      ...team,
      eventId: 'gala',
      summary: '26/27 U13B Azul - Casino Night Gala',
      start: '2026-10-23T17:00:00-07:00',
      end: '2026-10-23T22:30:00-07:00',
      location: 'Leon Event Hall\n5051 Mission Street, San Francisco, CA 94112',
    };
    const sourceEvents = [family, team, gala];
    const before = structuredClone(sourceEvents);
    for (const order of [
      [family, team, gala],
      [gala, team, family],
    ]) {
      const read = evidence(order);
      const projections = calendarResponseCards([read], request);
      expect(projections).toHaveLength(2);
      expect(projections.find((event) => event.probableMatch)).toMatchObject({
        title: family.summary,
        start: family.start,
        end: family.end,
        calendars: ['Family', 'SF United Soccer'],
        sourceVariants: [family, team].map(({ calendarId, eventId, start, location }) => ({
          calendarId,
          eventId,
          start,
          location,
        })),
      });
      const cards = responseCardsForFinal({
        evidence: [read],
        readRequest: request,
        requestText: ownerText,
      });
      const sections = cards[0]?.sections as Array<Record<string, unknown>>;
      const agendaItems = sections.find((section) => section.type === 'agenda')?.items as Array<
        Record<string, unknown>
      >;
      expect(agendaItems).toHaveLength(2);
      expect(agendaItems.find((item) => item.title === family.summary)).toMatchObject({
        time: '4:25 PM – 6:30 PM',
      });
      expect(JSON.stringify(agendaItems)).toContain('5:10 PM');
      const overlap = sections.find((section) => Array.isArray(section.overlaps));
      expect(overlap?.overlapCount).toBe(1);
      expect(overlap?.overlaps).toHaveLength(1);
      expect(JSON.stringify(overlap)).toContain(gala.summary);
    }
    expect(sourceEvents).toEqual(before);
  });

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
      lead: '13 calendar entries from Work.',
    });
    const sections = cards[0]?.sections as { type: string; items: unknown[] }[];
    expect(sections.find((s) => s.type === 'agenda')?.items).toHaveLength(13);
    expect(JSON.stringify(cards)).toContain('Your RSVP: needs a response.');
    const visibleAgenda = JSON.stringify(
      sections
        .find((section) => section.type === 'agenda')
        ?.items.map((item) => {
          const row = item as Record<string, unknown>;
          return { title: row.title, time: row.time, note: row.note };
        }),
    );
    expect(visibleAgenda).not.toContain('needsAction');
    expect(visibleAgenda).toContain('Your RSVP: accepted.');
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
    const sections = cards.flatMap((card) => card.sections ?? []) as Array<Record<string, unknown>>;
    expect(
      sections.some(
        (section) => section.type === 'attention' && /overlap/i.test(String(section.title)),
      ),
    ).toBe(false);
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

  it('labels verified owner RSVP only and keeps household organizer metadata in details', () => {
    const ownerAccepted = {
      status: 'accepted',
      identityVerified: true,
      basis: 'attendee-email',
    };
    const cards = responseCardsForFinal({
      evidence: [
        evidence([
          {
            ...event(1),
            eventId: 'family-school-event',
            calendarId: 'family',
            calendar: 'Family',
            summary: 'School pickup for Maya',
            organizer: 'Katharine <katharine@example.test>',
            ownerResponse: 'accepted',
            ownerParticipation: { status: 'unknown', identityVerified: false, basis: 'unverified' },
          },
          {
            ...event(2),
            eventId: 'owner-meeting',
            calendarId: 'work',
            calendar: 'Work',
            ownerParticipation: ownerAccepted,
          },
          {
            ...event(6),
            eventId: 'family-brunch-event',
            calendarId: 'family',
            calendar: 'Family',
            summary: 'Family brunch',
            organizer: 'Katharine <katharine@example.test>',
            ownerParticipation: { status: 'unknown', identityVerified: false, basis: 'unverified' },
          },
        ]),
      ],
      readRequest: request,
      requestText: ownerText,
    });
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const agenda = sections.find((section) => section.type === 'agenda');
    const rows = agenda?.items as Array<Record<string, unknown>>;
    const familyRow = rows.find((row) => row.title === 'School pickup for Maya');
    expect(familyRow?.note).toContain('Your RSVP: not verified.');
    expect(familyRow?.note).not.toContain('accepted');
    const eventDetails = sections.find((section) => section.title === 'Event details');
    expect(eventDetails?.items).toContainEqual({
      title: 'School pickup for Maya: Organizer: Katharine <katharine@example.test>',
      detail: 'Calendar source: Family',
    });
    expect(eventDetails?.items).toContainEqual({
      title: 'Family brunch: Organizer: Katharine <katharine@example.test>',
      detail: 'Calendar source: Family',
    });
    const overlaps = sections.find((section) => section.overlaps);
    expect(JSON.stringify(overlaps)).toContain('isn’t confirmed');
    expect(JSON.stringify(overlaps)).not.toContain('accepted commitment conflict');
    expect(JSON.stringify(cards)).not.toMatch(/assigned driver|you will drive|you are attending/i);
    const textFallback = calendarAgendaSummary(cards);
    expect(textFallback).toContain('Your RSVP: not verified.');
    expect(textFallback).toContain('School pickup for Maya: Organizer: Katharine');
    expect(textFallback).toContain('Calendars: Family');
    expect(textFallback).toContain('isn’t confirmed');
    expect(textFallback).not.toMatch(/assigned driver|you will drive|you are attending/i);
  });

  it.each([
    ['accepted', 'Your RSVP: accepted.'],
    ['declined', 'Your RSVP: declined.'],
    ['tentative', 'Your RSVP: tentative.'],
    ['needsAction', 'Your RSVP: needs a response.'],
    ['unknown', 'Your RSVP: unknown.'],
  ])('shows only the verified owner RSVP status %s', (status, expected) => {
    const cards = responseCardsForFinal({
      evidence: [
        evidence([
          {
            ...event(1),
            ownerParticipation: { status, identityVerified: true, basis: 'attendee-email' },
          },
        ]),
      ],
      readRequest: request,
      requestText: ownerText,
    });
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const agenda = sections.find((section) => section.type === 'agenda');
    const rows = agenda?.items as Array<Record<string, unknown>>;
    expect(rows[0]?.note).toContain(expected);
  });

  it('retains trusted recurring mirrors but keeps similar titles and adjacent recurrences distinct', () => {
    const currentOriginal = '2026-10-23T16:00:00Z';
    const cards = responseCardsForFinal({
      evidence: [
        evidence([
          {
            ...event(1),
            eventId: 'google-moved',
            calendarId: 'google-family',
            calendar: 'Family Google',
            summary: 'Pediatric appointment',
            iCalUID: 'trusted-series-uid',
            recurringEventId: 'series',
            originalStartTime: currentOriginal,
            start: '2026-10-23T17:00:00Z',
            end: '2026-10-23T18:00:00Z',
            organizer: 'Clinic <clinic@example.test>',
            ownerParticipation: {
              status: 'declined',
              identityVerified: true,
              basis: 'attendee-email',
            },
          },
          {
            ...event(2),
            eventId: 'iphone-moved',
            calendarId: 'iphone:family',
            calendar: 'Family iPhone',
            summary: 'Pediatric appointment',
            iCalUID: 'trusted-series-uid',
            recurringEventId: 'series',
            originalStartTime: currentOriginal,
            start: '2026-10-23T17:00:00Z',
            end: '2026-10-23T18:00:00Z',
            organizer: 'Clinic <clinic@example.test>',
          },
          {
            ...event(3),
            eventId: 'adjacent-occurrence',
            calendarId: 'google-family',
            calendar: 'Family Google',
            summary: 'Pediatric appointment',
            iCalUID: 'trusted-series-uid',
            recurringEventId: 'series',
            originalStartTime: '2026-10-23T18:00:00Z',
            start: '2026-10-23T18:00:00Z',
            end: '2026-10-23T19:00:00Z',
          },
          {
            ...event(4),
            eventId: 'similar-distinct-event',
            calendarId: 'school',
            calendar: 'School',
            summary: 'Pediatric appointment',
            iCalUID: 'another-series-uid',
            start: '2026-10-23T17:00:00Z',
            end: '2026-10-23T18:00:00Z',
          },
        ]),
      ],
      readRequest: request,
      requestText: ownerText,
    });
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const agenda = sections.find((section) => section.type === 'agenda');
    const rows = agenda?.items as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const mirrored = rows.find(
      (row) => Array.isArray(row.calendars) && row.calendars.includes('Family Google'),
    );
    expect(mirrored?.calendars).toEqual(['Family Google', 'Family iPhone']);
    expect(mirrored?.time).toContain('10:00 AM');
    expect(mirrored?.note).toContain('Your RSVP differs by calendar source.');
    expect(
      rows.some((row) => Array.isArray(row.calendars) && row.calendars.includes('School')),
    ).toBe(true);
    expect(rows.some((row) => String(row.id).includes('adjacent-occurrence'))).toBe(true);
    const details = sections.find((section) => section.title === 'Event details');
    expect(JSON.stringify(details)).toContain(
      'Pediatric appointment: Organizer: Clinic <clinic@example.test>',
    );
    expect(JSON.stringify(details)).toContain('Calendar source: Family iPhone');
  });

  it('shows exact phone snapshot freshness, source window, searched scope and permission gaps', () => {
    const cards = responseCardsForFinal({
      evidence: [
        {
          ...evidence([
            {
              ...event(1),
              eventId: 'phone-family-event',
              calendarId: 'iphone:family',
              calendar: 'Family iPhone',
            },
          ]),
          args: {
            timeMin: '2026-10-23T07:00:00.000Z',
            timeMax: '2026-10-24T07:00:00.000Z',
          },
          result: {
            complete: false,
            events: [
              {
                ...event(1),
                eventId: 'phone-family-event',
                calendarId: 'iphone:family',
                calendar: 'Family iPhone',
              },
            ],
            calendarsResolved: [
              { id: 'google-work', name: 'Work', timeZone: 'America/Los_Angeles' },
              { id: 'iphone:family', name: 'Family iPhone', timeZone: 'America/Los_Angeles' },
              { id: 'iphone:school', name: 'School iPhone', timeZone: 'America/Los_Angeles' },
            ],
            calendarsSearched: ['Work', 'Family iPhone'],
            calendarsSearchedIds: ['google-work', 'iphone:family'],
            calendarRosterComplete: true,
            unavailable: [
              { calendar: 'School iPhone', reason: 'Calendar permission was revoked.' },
            ],
            phoneCalendarCoverage: {
              complete: false,
              capturedAt: '2026-10-23T05:00:00.000Z',
              receivedAt: '2026-10-23T05:05:00.000Z',
              timeMin: '2026-10-23T00:00:00.000Z',
              timeMax: '2026-10-24T00:00:00.000Z',
              sources: [
                { calendarId: 'family', status: 'available', complete: true },
                {
                  calendarId: 'school',
                  status: 'permission-denied',
                  complete: false,
                  reason: 'Calendar permission was revoked.',
                },
                { calendarId: 'old-family', status: 'missing', complete: false },
              ],
              note: 'iPhone calendar coverage is incomplete; last shared snapshot may be stale.',
            },
            note: 'Searched the listed Google and iPhone calendars only.',
          },
        },
      ],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards[0]?.complete).toBe(false);
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const coverage = sections.find((section) => section.title === 'Calendar read coverage');
    const coverageText = JSON.stringify(coverage);
    expect(coverageText).toContain('Requested window');
    expect(coverageText).toContain('2026-10-23T07:00:00.000Z to 2026-10-24T07:00:00.000Z');
    expect(coverageText).toContain('Captured at 2026-10-23T05:00:00.000Z');
    expect(coverageText).toContain('received by Assistant at 2026-10-23T05:05:00.000Z');
    expect(coverageText).toContain('2026-10-23T00:00:00.000Z to 2026-10-24T00:00:00.000Z');
    expect(coverageText).toContain('permission-denied');
    expect(coverageText).toContain('missing');
    expect(coverageText).toContain('Family iPhone');
    expect(coverageText).toContain('School iPhone');
    expect(coverageText).toContain('last shared snapshot may be stale');
    expect(coverageText).not.toContain('Fetched at');
    expect(coverageText).not.toContain('iphone:family');
    const unavailable = sections.find((section) => section.title === 'Calendars not checked');
    expect(JSON.stringify(unavailable)).toContain('Calendar permission was revoked.');
    const textFallback = calendarAgendaSummary(cards);
    expect(textFallback).toContain('Captured at 2026-10-23T05:00:00.000Z');
    expect(textFallback).toContain('permission-denied');
    expect(textFallback).toContain('Calendar permission was revoked.');
    expect(textFallback).not.toContain('iphone:family');
  });

  it('keeps the owner display zone in text across the DST fold when the source zone differs', () => {
    const dstRequest = detectPersonalReadRequest([{ role: 'user', content: ownerText }], {
      now: new Date('2026-10-31T18:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!dstRequest?.timeWindow) throw new Error('Expected bounded DST request');
    const cards = responseCardsForFinal({
      evidence: [
        {
          ...evidence([]),
          args: { timeMin: dstRequest.timeWindow.timeMin, timeMax: dstRequest.timeWindow.timeMax },
          result: {
            complete: true,
            calendarsSearched: ['Work'],
            calendarsSearchedIds: ['work'],
            calendarsResolved: [{ id: 'work', name: 'Work', timeZone: 'America/New_York' }],
            events: [
              {
                ...event(0),
                summary: 'First fold occurrence',
                start: '2026-11-01T08:30:00Z',
                end: '2026-11-01T08:45:00Z',
                calendarTimeZone: 'America/New_York',
              },
              {
                ...event(1),
                summary: 'Second fold occurrence',
                start: '2026-11-01T09:30:00Z',
                end: '2026-11-01T09:45:00Z',
                calendarTimeZone: 'America/New_York',
              },
            ],
          },
        },
      ],
      readRequest: dstRequest,
      requestText: ownerText,
    });
    const fallback = calendarAgendaSummary(cards);
    expect(fallback).toContain('Display time zone: America/Los_Angeles');
    expect(fallback).not.toContain('Display time zone: America/New_York');
    expect(fallback).toContain('First fold occurrence');
    expect(fallback).toContain('Second fold occurrence');
    expect(fallback).toContain('Source freshness unavailable');
    expect(fallback).not.toMatch(/Fetched at|Checked at/);
    const absentZone = calendarAgendaSummary(
      cards.map((card) => ({ ...card, timeZone: undefined })),
    );
    expect(absentZone).toContain('Display time zone unavailable.');
    expect(absentZone).not.toContain('Display time zone: America/New_York');
    const invalidZone = calendarAgendaSummary(
      cards.map((card) => ({ ...card, timeZone: 'Not/AZone' })),
    );
    expect(invalidZone).toContain('Display time zone unavailable.');
  });

  it('does not substitute receive time for a missing phone capture or infer an omitted phone source', () => {
    const cards = responseCardsForFinal({
      evidence: [
        {
          ...evidence([]),
          result: {
            complete: false,
            events: [],
            calendarsResolved: [{ id: 'iphone:family', name: 'Family iPhone' }],
            calendarsSearchedIds: ['iphone:family'],
            phoneCalendarCoverage: {
              complete: false,
              receivedAt: '2026-10-23T05:05:00.000Z',
              timeMin: '2026-10-23T00:00:00.000Z',
              timeMax: '2026-10-24T00:00:00.000Z',
              note: 'Phone capture time was not supplied.',
            },
          },
        },
      ],
      readRequest: request,
      requestText: ownerText,
    });
    expect(cards[0]?.complete).toBe(false);
    const sections = (cards[0]?.sections ?? []) as Array<Record<string, unknown>>;
    const coverage = sections.find((section) => section.title === 'Calendar read coverage');
    const coverageText = JSON.stringify(coverage);
    expect(coverageText).toContain('Capture time not reported');
    expect(coverageText).toContain('received by Assistant at 2026-10-23T05:05:00.000Z');
    expect(coverageText).not.toContain('Captured at 2026-10-23T05:05:00.000Z');
    const textFallback = calendarAgendaSummary(cards);
    expect(textFallback).toContain('Capture time not reported');
    expect(textFallback).toContain('received by Assistant at 2026-10-23T05:05:00.000Z');
    expect(textFallback).not.toContain('iphone:family');
  });
});
