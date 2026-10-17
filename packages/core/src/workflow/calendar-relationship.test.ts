import { describe, expect, it } from 'vitest';
import { type BriefingCalendarEvent, findConflicts } from './briefing.js';
import { agendaSection } from './briefing-card.js';
import {
  calendarArrivalLead,
  calendarRelationship,
  calendarRelationshipNote,
} from './calendar-relationship.js';

const arrival: BriefingCalendarEvent = {
  calendarId: 'family',
  eventId: 'one',
  calendar: 'Family',
  summary: 'United Albion arrival',
  location: 'East Entrance',
  description: 'Venue aliases: East Entrance | West Entrance',
  start: '2026-10-07T18:15:00Z',
  end: '2026-10-07T20:30:00Z',
  allDay: false,
};
const kickoff: BriefingCalendarEvent = {
  ...arrival,
  calendarId: 'team',
  eventId: 'two',
  calendar: 'Team',
  summary: 'United Albion kickoff',
  location: 'West Entrance',
  description: '',
  start: '2026-10-07T19:00:00Z',
};
describe('advisory calendar relationships', () => {
  it('reconciles an explicit arrival offset only with a matching street, end and title clock', () => {
    const early = {
      ...arrival,
      summary: 'Albion v Riverside (5:10PM)',
      location: 'Arena, 100 Example Road, Example City',
      start: '2026-10-18T23:25:00Z',
      end: '2026-10-19T01:30:00Z',
    };
    const game = {
      ...kickoff,
      summary: 'Riverside United Boys',
      location: 'Arena\n100 Example Road, Example City',
      description: 'Arrival: 45 minutes in advance',
      start: '2026-10-18T17:10:00-07:00',
      end: '2026-10-18T18:30:00-07:00',
    };
    expect(calendarArrivalLead(early, game)).toBe(45);
    for (const changed of [
      { ...game, description: '' },
      { ...game, location: '100 Different Road' },
      { ...game, end: '2026-10-18T19:00:00-07:00' },
      { ...game, summary: 'Other Teams' },
      { ...game, calendarId: early.calendarId },
    ])
      expect(calendarArrivalLead(early, changed)).toBeUndefined();
    expect(
      calendarArrivalLead({ ...early, summary: 'Albion v Riverside (6:10PM)' }, game),
    ).toBeUndefined();
    expect(calendarRelationship(early, game)).toBe('unresolved');
  });
  it('retains arrival and kickoff sources/times with an explicit venue alias statement', () => {
    expect(calendarRelationship(arrival, kickoff)).toBe('compatible_time_roles');
    const conflicts = findConflicts([arrival, kickoff]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.a[0]?.start).toBe(arrival.start);
    expect(conflicts[0]?.b[0]?.start).toBe(kickoff.start);
    const agenda = agendaSection({
      events: [arrival, kickoff],
      complete: true,
      conflicts,
      salient: [],
      timeZone: 'UTC',
      now: new Date(arrival.start),
    });
    expect(
      agenda?.type === 'agenda' &&
        agenda.items.every((item) => item.note?.includes('earlier arrival')),
    ).toBe(true);
  });
  it('does not invent alias, attendance, participant or recurrence identity', () => {
    expect(calendarRelationship({ ...arrival, description: '' }, kickoff)).toBe('unresolved');
    expect(calendarRelationship(arrival, { ...kickoff, summary: 'Other Albion kickoff' })).toBe(
      'unresolved',
    );
    expect(calendarRelationship(arrival, { ...kickoff, calendarId: arrival.calendarId })).toBe(
      'unresolved',
    );
    expect(
      calendarRelationship(
        { ...arrival, recurringEventId: 'series', originalStartTime: arrival.start },
        { ...kickoff, recurringEventId: 'series', originalStartTime: kickoff.start },
      ),
    ).toBe('unresolved');
    expect(calendarRelationship(kickoff, { ...arrival, start: '2026-10-07T19:15:00Z' })).toBe(
      'unresolved',
    );
    expect(calendarRelationshipNote('unresolved', 'unresolved')).toContain('not established');
  });
  it('labels matching descriptive listings as probable while keeping both sources', () => {
    const copy = { ...arrival, calendarId: 'personal', eventId: 'copy', description: '' };
    expect(calendarRelationship(arrival, copy)).toBe('probable_duplicate');
    expect(findConflicts([arrival, copy])).toHaveLength(1);
    expect(calendarRelationshipNote('probable_duplicate', 'confirmed')).toContain(
      'Both sources are retained',
    );
  });
});
