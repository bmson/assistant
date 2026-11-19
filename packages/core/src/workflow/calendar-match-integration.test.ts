import { describe, expect, it } from 'vitest';
import { type BriefingCalendarEvent, findConflicts } from './briefing.js';
import { agendaSection } from './briefing-card.js';
import { calendarGroupRelationship } from './calendar-relationship.js';
import type { PersonalReadRequest } from './read-intent.js';
import { calendarResponseCards, responseCardsForFinal } from './response-cards.js';
import { verifiedReadResponse } from './response-contract.js';
import { weeklyCalendarPlan } from './weekly-calendar-plan.js';

const timeMin = '2026-11-09T00:00:00Z';
const timeMax = '2026-11-10T00:00:00Z';
const request: PersonalReadRequest = {
  kind: 'calendar',
  firstToolName: 'calendar.list_events',
  requiresThreadRead: false,
  queryTerms: [],
  timeZone: 'UTC',
  timeWindow: { timeMin, timeMax, label: 'Monday' },
  includeCalendarBriefing: true,
  includeCalendarOverlapSummary: true,
};
const left: BriefingCalendarEvent = {
  eventId: 'dentist-family',
  calendarId: 'family',
  calendar: 'Family',
  summary: 'Dentist Chen',
  start: '2026-11-09T09:00:00Z',
  end: '2026-11-09T10:00:00Z',
  location: 'Sunset Dental, 123 Main Street',
  allDay: false,
  blocksTime: true,
  ownerParticipation: { status: 'accepted', identityVerified: true, basis: 'attendee-email' },
};
const right: BriefingCalendarEvent = {
  ...left,
  eventId: 'dentist-medical',
  calendarId: 'medical',
  calendar: 'Medical',
  start: '2026-11-09T09:30:00Z',
};
const read = (events: readonly BriefingCalendarEvent[]) => ({
  toolName: 'calendar.list_events',
  status: 'succeeded',
  args: { timeMin, timeMax },
  result: {
    events,
    complete: true,
    calendarRosterComplete: true,
    unavailable: [],
    calendarsSearched: ['Family', 'Medical'],
  },
});

describe('calendar matching across answer surfaces', () => {
  it('keeps uncertain copies visible without declaring two accepted invitations a definite conflict', () => {
    const evidence = [read([left, right])];
    expect(calendarResponseCards(evidence, request)).toHaveLength(2);
    const cards = responseCardsForFinal({
      evidence,
      readRequest: request,
      requestText: 'Show my calendar Monday. Do I need to drive?',
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    expect(sections.find((section) => section.type === 'agenda')?.items).toHaveLength(2);
    expect(sections.some((section) => section.overlaps)).toBe(false);
    expect(JSON.stringify(sections)).toContain('Possibly the same event');
    expect(JSON.stringify(cards)).not.toContain('accepted commitment conflict');
    expect(cards[0]?.householdDay?.nextQuestion).toBeUndefined();
    const prose = verifiedReadResponse(request, evidence);
    expect(prose).toContain('Possibly the same event');
    expect(prose).not.toContain('Your accepted commitments overlap');
    const comparisons = findConflicts([left, right], 'UTC');
    expect(comparisons.conflictCount).toBe(0);
    expect(comparisons[0]?.relationship).toBe('possible_duplicate');
    const agenda = agendaSection({
      events: [left, right],
      complete: true,
      conflicts: comparisons,
      salient: [],
      timeZone: 'UTC',
      now: new Date(timeMin),
    });
    expect(
      agenda?.type === 'agenda' && agenda.items.every((item) => item.flag !== 'conflict'),
    ).toBe(true);
    expect(JSON.stringify(agenda)).toContain('Possibly the same event');
    const plan = weeklyCalendarPlan({
      timeMin,
      timeMax,
      timeZone: 'UTC',
      evidence: [
        {
          toolName: 'calendar.availability',
          status: 'succeeded',
          args: { timeMin, timeMax },
          result: {
            complete: true,
            busy: [{ start: left.start, end: left.end }],
            unavailable: [],
            calendarsChecked: ['Family', 'Medical'],
          },
        },
        ...evidence,
      ],
    });
    expect(plan).toContain('Possible matching calendar entries');
    expect(plan).not.toContain('Scheduling conflict:');
    expect(plan).not.toContain('choose which invite to keep');
  });

  it('retains real third-event conflicts and does not use an uncertain match to clear the schedule', () => {
    const interview = {
      ...left,
      calendarId: 'work',
      eventId: 'interview',
      calendar: 'Work',
      summary: 'Interview Alex',
      start: '2026-11-09T09:45:00Z',
      end: '2026-11-09T10:30:00Z',
      location: 'Other Office',
    };
    const cards = responseCardsForFinal({
      evidence: [read([left, right, interview])],
      readRequest: request,
      requestText: 'Show my calendar Monday',
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    expect(sections.find((section) => section.overlaps)?.overlapCount).toBe(2);
    expect(JSON.stringify(sections)).toContain('Interview Alex');
    expect(findConflicts([left, right, interview], 'UTC').conflictCount).toBe(2);
  });

  it('groups renamed lessons and preserves a later source end when checking a subsequent appointment', () => {
    const lesson = { ...left, summary: 'Maya piano lesson' };
    const copy = {
      ...right,
      summary: 'Piano class for Maya',
      start: lesson.start,
      end: '2026-11-09T10:10:00Z',
    };
    const following = {
      ...left,
      calendarId: 'work',
      eventId: 'interview',
      summary: 'Interview Alex',
      start: '2026-11-09T10:05:00Z',
      end: '2026-11-09T11:00:00Z',
      location: 'Other Office',
    };
    const evidence = [read([lesson, copy, following])];
    const projections = calendarResponseCards(evidence, request);
    expect(projections).toHaveLength(2);
    expect(projections.find((event) => event.probableMatch)).toMatchObject({
      start: lesson.start,
      end: copy.end,
    });
    const cards = responseCardsForFinal({
      evidence,
      readRequest: request,
      requestText: 'Show my calendar Monday',
    });
    const sections = cards[0]?.sections as Array<Record<string, unknown>>;
    expect(sections.find((section) => section.overlaps)?.overlapCount).toBe(1);
    expect(JSON.stringify(sections)).toContain('10:10 AM');
  });

  it('does not let one matching variant hide a contradictory source in an existing group', () => {
    expect(
      calendarGroupRelationship(
        [
          { ...left, location: 'Sunset Studio, room 1' },
          { ...left, location: 'Sunset Studio, room 2' },
        ],
        [{ ...right, start: left.start, location: 'Sunset Studio, room 1' }],
        'UTC',
      ),
    ).toBe('unresolved');
    expect(
      calendarGroupRelationship(
        [left, { ...left, status: 'cancelled' }],
        [{ ...right, start: left.start }],
      ),
    ).toBe('unresolved');
  });
});
