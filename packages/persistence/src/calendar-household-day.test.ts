import { describe, expect, it } from 'vitest';
import {
  calendarHouseholdItemHasAcceptedRSVP,
  parseCalendarHouseholdComparison,
  parseCalendarHouseholdDay,
  parseCalendarHouseholdItem,
} from './calendar-household-day.js';

describe('calendar household day optional payload parsers', () => {
  it('accepts complete versioned day coverage and an exact pair question', () => {
    expect(
      parseCalendarHouseholdDay({
        version: 1,
        coverage: {
          complete: false,
          summary: 'Coverage incomplete.',
          freshnessSummary: 'Freshness unavailable.',
          details: [{ title: 'Phone calendar', detail: 'Not checked.' }],
        },
        nextQuestion: {
          basis: 'verified_owner_accepted_overlap',
          id: 'overlap-a-b',
          question: 'Do you need to decide how to handle this overlap?',
          detail: 'Driving is not stated.',
          eventIds: ['a', 'b'],
          remainingIssueCount: 2,
        },
      }),
    ).toMatchObject({ version: 1, nextQuestion: { eventIds: ['a', 'b'] } });
  });

  it('rejects malformed optional day data without requiring it on the card', () => {
    expect(parseCalendarHouseholdDay(undefined)).toBeNull();
    expect(
      parseCalendarHouseholdDay({
        version: 1,
        coverage: { complete: true, summary: 'Complete', freshnessSummary: 'Unknown', details: [] },
        nextQuestion: {
          basis: 'verified_owner_accepted_overlap',
          id: 'x',
          question: 'Q',
          detail: 'D',
          eventIds: ['a'],
          remainingIssueCount: 0,
        },
      }),
    ).toBeNull();
    expect(
      parseCalendarHouseholdDay({
        version: 1,
        coverage: { complete: true, summary: 'Complete', freshnessSummary: 'Unknown', details: [] },
        nextQuestion: {
          basis: 'verified_owner_accepted_overlap',
          id: 'x',
          question: 'Q',
          detail: 'D',
          eventIds: ['same', 'same'],
          remainingIssueCount: 0,
        },
      }),
    ).toBeNull();
    expect(
      parseCalendarHouseholdDay({
        version: 1,
        coverage: { complete: true, summary: 'Complete', freshnessSummary: 'Unknown', details: [] },
        nextQuestion: {
          id: 'x',
          question: 'Q',
          detail: 'D',
          eventIds: ['a', 'b'],
          remainingIssueCount: 0,
        },
      }),
    ).toBeNull();
    expect(
      parseCalendarHouseholdDay({
        version: 1,
        coverage: {
          complete: true,
          summary: 'Complete',
          freshnessSummary: 'Unknown',
          details: [{}],
        },
      }),
    ).toBeNull();
  });

  it('preserves source-level RSVP distinctions and requires For/driver to stay not stated', () => {
    const item = {
      version: 1,
      sources: [
        {
          calendar: 'Work',
          title: 'Workshop',
          start: '2026-11-04T16:00:00-08:00',
          end: '2026-11-04T17:00:00-08:00',
          timeZone: 'America/Los_Angeles',
          allDay: false,
          rsvp: 'accepted',
        },
        {
          calendar: 'Phone',
          title: 'Workshop',
          start: '2026-11-04T16:00:00-08:00',
          allDay: false,
          rsvp: 'not_verified',
        },
      ],
      eventFor: 'not_stated',
      driving: 'not_stated',
    };
    expect(parseCalendarHouseholdItem(item)?.sources.map((source) => source.rsvp)).toEqual([
      'accepted',
      'not_verified',
    ]);
    expect(parseCalendarHouseholdItem({ ...item, driving: 'you' })).toBeNull();
    expect(
      parseCalendarHouseholdItem({ ...item, sources: [{ ...item.sources[0], rsvp: 'present' }] }),
    ).toBeNull();
  });

  it('accepts only comparisons that reference two distinct exact event IDs', () => {
    expect(
      parseCalendarHouseholdComparison({ version: 1, leftEventId: 'a', rightEventId: 'b' }),
    ).toEqual({
      version: 1,
      leftEventId: 'a',
      rightEventId: 'b',
    });
    expect(
      parseCalendarHouseholdComparison({ version: 1, leftEventId: 'a', rightEventId: 'a' }),
    ).toBeNull();
    expect(
      parseCalendarHouseholdComparison({ version: 1, leftEventId: 'a', rightEventId: '' }),
    ).toBeNull();
  });

  it('requires every source RSVP to be accepted for the shared conservative question guard', () => {
    const item = {
      version: 1,
      sources: [
        {
          calendar: 'Work',
          title: 'Workshop',
          start: '2026-11-04T16:00:00-08:00',
          allDay: false,
          rsvp: 'accepted',
        },
      ],
      eventFor: 'not_stated',
      driving: 'not_stated',
    };
    expect(calendarHouseholdItemHasAcceptedRSVP(item)).toBe(true);
    expect(
      calendarHouseholdItemHasAcceptedRSVP({
        ...item,
        sources: [...item.sources, { ...item.sources[0], calendar: 'Phone', rsvp: 'declined' }],
      }),
    ).toBe(false);
    expect(
      calendarHouseholdItemHasAcceptedRSVP({
        ...item,
        sources: [...item.sources, { ...item.sources[0], calendar: 'Phone', rsvp: 'not_verified' }],
      }),
    ).toBe(false);
    expect(calendarHouseholdItemHasAcceptedRSVP(undefined)).toBe(false);
  });

  it('returns null for sparse arrays and throwing getters instead of accepting or throwing', () => {
    const sparseDetails = new Array(1);
    const sparseSources = new Array(1);
    const sparseEventIds = new Array(2);
    const validDay = {
      version: 1,
      coverage: { complete: true, summary: 'Complete', freshnessSummary: 'Unknown', details: [] },
    };
    const validItem = {
      version: 1,
      sources: [
        {
          calendar: 'Work',
          title: 'Workshop',
          start: '2026-11-04T16:00:00Z',
          allDay: false,
          rsvp: 'accepted',
        },
      ],
      eventFor: 'not_stated',
      driving: 'not_stated',
    };
    expect(
      parseCalendarHouseholdDay({
        ...validDay,
        coverage: { ...validDay.coverage, details: sparseDetails },
      }),
    ).toBeNull();
    expect(parseCalendarHouseholdItem({ ...validItem, sources: sparseSources })).toBeNull();
    expect(
      parseCalendarHouseholdDay({
        ...validDay,
        nextQuestion: {
          basis: 'verified_owner_accepted_overlap',
          id: 'q',
          question: 'Q',
          detail: 'D',
          eventIds: sparseEventIds,
          remainingIssueCount: 0,
        },
      }),
    ).toBeNull();
    const throwingDay = Object.defineProperty({}, 'version', {
      get() {
        throw new Error('getter failed');
      },
    });
    const throwingItem = Object.defineProperty({}, 'sources', {
      get() {
        throw new Error('getter failed');
      },
    });
    expect(() => parseCalendarHouseholdDay(throwingDay)).not.toThrow();
    expect(parseCalendarHouseholdDay(throwingDay)).toBeNull();
    expect(() => parseCalendarHouseholdItem(throwingItem)).not.toThrow();
    expect(parseCalendarHouseholdItem(throwingItem)).toBeNull();
    expect(() => parseCalendarHouseholdComparison(throwingDay)).not.toThrow();
    expect(parseCalendarHouseholdComparison(throwingDay)).toBeNull();
  });
});
