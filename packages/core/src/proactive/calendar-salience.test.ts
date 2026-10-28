import { describe, expect, it } from 'vitest';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import {
  describeSalience,
  SALIENCE_THRESHOLD,
  type SalienceContext,
  salientEvents,
  scoreCalendarEvent,
} from './calendar-salience.js';

const ctx: SalienceContext = {
  timeZone: 'Atlantic/Reykjavik',
  selfEmails: ['owner@example.com', 'assistant@example.com'],
};

/** Reykjavik sits at UTC year-round, so these ISO hours are also local hours. */
function event(over: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
  return {
    summary: 'Standup',
    start: '2026-03-04T10:00:00Z',
    end: '2026-03-04T10:30:00Z',
    calendar: 'Work',
    allDay: false,
    ...over,
  };
}

describe('scoreCalendarEvent', () => {
  it('scores an ordinary desk meeting as not worth interrupting for', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (accepted)', 'colleague@example.com (accepted)'] }),
      ctx,
    );
    expect(scored.score).toBeLessThan(SALIENCE_THRESHOLD);
    expect(scored.reasons).toEqual([]);
  });

  it('treats an unanswered invitation as the strongest single signal', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (needsAction)'] }),
      ctx,
    );
    expect(scored.score).toBeGreaterThanOrEqual(SALIENCE_THRESHOLD);
    expect(scored.reasons).toContain('you have not replied to the invitation');
  });

  it('does not read someone else’s pending RSVP as the owner’s', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (accepted)', 'someone@else.com (needsAction)'] }),
      ctx,
    );
    expect(scored.reasons).not.toContain('you have not replied to the invitation');
  });

  it('suppresses a verified declined invitation even when the event would otherwise be salient', () => {
    const scored = scoreCalendarEvent(
      event({
        location: 'Clinic, 14 Main Street',
        ownerResponse: 'accepted',
        ownerParticipation: {
          status: 'declined',
          identityVerified: true,
          basis: 'attendee-email',
        },
      }),
      ctx,
    );
    expect(scored.score).toBe(0);
    expect(scored.reasons).toEqual([]);
  });

  it('does not treat a reference-calendar row or unverified legacy response as an owner RSVP', () => {
    const scored = scoreCalendarEvent(
      event({
        calendarPurpose: 'reference',
        ownerResponse: 'needsAction',
        ownerParticipation: {
          status: 'unknown',
          identityVerified: false,
          basis: 'unverified',
        },
      }),
      ctx,
    );
    expect(scored.score).toBe(0);
    expect(scored.reasons).not.toContain('you have not replied to the invitation');
  });

  it('uses a verified phone owner RSVP when attendee strings are absent', () => {
    const scored = scoreCalendarEvent(
      event({
        ownerParticipation: {
          status: 'needsAction',
          identityVerified: true,
          basis: 'attendee-email',
        },
      }),
      ctx,
    );
    expect(scored.reasons).toContain('you have not replied to the invitation');
  });

  it('counts a physical location as travel but a video link as not', () => {
    const physical = scoreCalendarEvent(event({ location: 'Laugavegur 12, Reykjavik' }), ctx);
    expect(physical.reasons.some((r) => r.startsWith('it is at'))).toBe(true);

    const video = scoreCalendarEvent(
      event({ location: 'https://meet.google.com/abc-defg-hij' }),
      ctx,
    );
    expect(video.reasons.some((r) => r.startsWith('it is at'))).toBe(false);
  });

  it('states the exact early-start and late-end facts without changing their shared score', () => {
    const early = scoreCalendarEvent(
      event({ start: '2026-03-04T07:59:00Z', end: '2026-03-04T08:30:00Z' }),
      ctx,
    );
    expect(early.score).toBe(2);
    expect(early.reasons).toContain('it starts before 8 AM');

    const late = scoreCalendarEvent(
      event({ start: '2026-03-04T18:30:00Z', end: '2026-03-04T19:00:00Z' }),
      ctx,
    );
    expect(late.score).toBe(2);
    expect(late.reasons).toContain('it ends at or after 7 PM');

    const both = scoreCalendarEvent(
      event({ start: '2026-03-04T07:00:00Z', end: '2026-03-04T19:00:00Z' }),
      ctx,
    );
    expect(both.score).toBe(3);
    expect(both.reasons).toContain('it starts before 8 AM');
    expect(both.reasons).toContain('it ends at or after 7 PM');
    expect(both.reasons).toContain('it runs for most of a working block');

    const longOnly = scoreCalendarEvent(
      event({ start: '2026-03-04T08:00:00Z', end: '2026-03-04T11:00:00Z' }),
      ctx,
    );
    expect(longOnly.score).toBe(1);
    expect(longOnly.reasons).toContain('it runs for most of a working block');

    const boundary = scoreCalendarEvent(
      event({ start: '2026-03-04T08:00:00Z', end: '2026-03-04T08:30:00Z' }),
      ctx,
    );
    expect(boundary.score).toBe(0);
    expect(boundary.reasons).toEqual([]);
  });

  it('evaluates hour wording in the configured owner time zone across the DST boundary', () => {
    const losAngeles = { ...ctx, timeZone: 'America/Los_Angeles' };
    const beforeEight = scoreCalendarEvent(
      event({ start: '2026-03-08T14:59:00Z', end: '2026-03-08T15:30:00Z' }),
      losAngeles,
    );
    expect(beforeEight.reasons).toContain('it starts before 8 AM');

    const exactlyEight = scoreCalendarEvent(
      event({ start: '2026-03-08T15:00:00Z', end: '2026-03-08T16:00:00Z' }),
      losAngeles,
    );
    expect(exactlyEight.reasons).not.toContain('it starts before 8 AM');

    const exactlySevenPmEnd = scoreCalendarEvent(
      event({ start: '2026-03-09T01:00:00Z', end: '2026-03-09T02:00:00Z' }),
      losAngeles,
    );
    expect(exactlySevenPmEnd.reasons).toContain('it ends at or after 7 PM');
  });

  it('recognises an outside organizer but not an in-house one', () => {
    // The owner reads this sentence, so it names the person when the field
    // carries a name and falls back to the bare address only when it does not.
    const named = scoreCalendarEvent(event({ organizer: 'Dr Ling <clinic@hospital.is>' }), ctx);
    expect(named.reasons).toContain('Dr Ling called it');
    expect(named.reasons).not.toContain('clinic@hospital.is called it');

    const bare = scoreCalendarEvent(event({ organizer: 'clinic@hospital.is' }), ctx);
    expect(bare.reasons).toContain('clinic@hospital.is called it');

    const inside = scoreCalendarEvent(event({ organizer: 'owner@example.com' }), ctx);
    expect(inside.reasons.some((r) => r.endsWith('called it'))).toBe(false);
  });

  it('ignores the synthetic organizer Google mints for a subscribed calendar', () => {
    // A subscribed ICS feed, a shared group calendar and a bookable room all
    // organize themselves. Nobody called the meeting, and the id is an internal
    // identifier the owner should never be shown.
    for (const organizer of [
      'sjp0f5m7cp05qdr1ls2c1j4v1na0uvl1@import.calendar.google.com',
      'abc123@group.calendar.google.com',
      'room-4@resource.calendar.google.com',
    ]) {
      const scored = scoreCalendarEvent(event({ organizer }), ctx);
      expect(scored.reasons.some((r) => r.endsWith('called it'))).toBe(false);
      expect(scored.reasons.join(' ')).not.toContain('calendar.google.com');
    }
  });

  it('scores an all-day entry and a crowded meeting', () => {
    expect(scoreCalendarEvent(event({ allDay: true }), ctx).reasons).toContain(
      'it takes the whole day',
    );
    const crowded = scoreCalendarEvent(
      event({
        attendees: [
          'a@x.com (accepted)',
          'b@x.com (accepted)',
          'c@x.com (accepted)',
          'd@x.com (accepted)',
          'e@x.com (accepted)',
        ],
      }),
      ctx,
    );
    expect(crowded.reasons).toContain('5 people are on it');
  });

  it('survives events the provider left half-populated', () => {
    const scored = scoreCalendarEvent(
      { summary: '', start: 'not-a-date', end: '', calendar: '', allDay: false },
      ctx,
    );
    expect(Number.isFinite(scored.score)).toBe(true);
  });
});

describe('salientEvents', () => {
  it('keeps only what clears the bar, most salient first, soonest breaking ties', () => {
    const routine = event({ summary: 'Standup' });
    const flight = event({
      summary: 'Flight to Oslo',
      start: '2026-03-04T05:00:00Z',
      end: '2026-03-04T09:00:00Z',
      location: 'Keflavik Airport',
    });
    const later = event({
      summary: 'Dentist',
      start: '2026-03-04T17:00:00Z',
      end: '2026-03-04T21:00:00Z',
      location: 'Somewhere',
    });
    const earlier = event({
      summary: 'Optician',
      start: '2026-03-04T07:00:00Z',
      end: '2026-03-04T11:00:00Z',
      location: 'Somewhere else',
    });

    const found = salientEvents([routine, later, flight, earlier], ctx);
    expect(found.map((s) => s.event.summary)).not.toContain('Standup');
    // `later` and `earlier` score identically; the earlier one must come first.
    const summaries = found.map((s) => s.event.summary);
    expect(summaries.indexOf('Optician')).toBeLessThan(summaries.indexOf('Dentist'));
  });

  it('renders a line the digest can use verbatim', () => {
    const [scored] = salientEvents(
      [event({ attendees: ['owner@example.com (needsAction)'] })],
      ctx,
    );
    expect(scored).toBeDefined();
    expect(describeSalience(scored as NonNullable<typeof scored>, ctx.timeZone)).toContain(
      'Standup',
    );
  });

  it('renders a Z-stamped event in the passed timezone, not UTC', () => {
    // Reykjavik sits at UTC year-round in these fixtures, so use a zone with a
    // real offset to prove the timestamp is actually being converted. Scored
    // directly rather than through `salientEvents`, which would filter an event
    // carrying no salience signal before there was anything to describe.
    const scored = scoreCalendarEvent(
      event({ start: '2026-03-04T23:30:00Z', end: '2026-03-05T00:00:00Z', allDay: false }),
      ctx,
    );
    const line = describeSalience(scored, 'America/Los_Angeles');
    // 23:30 UTC on Mar 4 is 15:30 (3:30 PM) Los Angeles time, still Mar 4.
    expect(line).toContain('3:30 PM');
    expect(line).not.toContain('23:30');
    expect(line).not.toContain('2026-03-04T23:30:00Z');
  });

  it('produces no embedded newline when the event location contains one', () => {
    const messyLocation = 'Crocker Amazon\n1669 Geneva Avenue, San Francisco, CA 94134';
    const scored = scoreCalendarEvent(event({ location: messyLocation }), ctx);
    const line = describeSalience(scored, ctx.timeZone);
    expect(line).not.toContain('\n');
    expect(line).toContain('Crocker Amazon 1669 Geneva Avenue, San Francisco, CA 94134');
  });
});
