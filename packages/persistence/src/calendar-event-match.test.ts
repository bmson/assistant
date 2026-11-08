import { describe, expect, it } from 'vitest';
import { type CalendarMatchCandidate, calendarEventMatchEvidence } from './calendar-event-match.js';
import { sameCalendarOccurrence } from './calendar-occurrence.js';

function event(
  summary: string,
  calendarId: string,
  extra: Partial<CalendarMatchCandidate> = {},
): CalendarMatchCandidate {
  return {
    calendarId,
    eventId: calendarId,
    summary,
    start: '2026-11-09T17:00:00Z',
    end: '2026-11-09T18:00:00Z',
    location: 'Sunset Studio, 123 Main St',
    ...extra,
  };
}

describe('general calendar event matching', () => {
  it.each([
    ['Dental check-up with Dr Chen', 'Dentist Chen'],
    ['Dr Chen check-up', 'Medical appointment with Chen'],
    ['Physical therapy Alex', 'Alex physio appointment'],
    ['Apollo 1:1 with Alex', 'Alex Apollo catch-up'],
    ['Maya piano lesson', 'Piano class for Maya'],
    ['Pick-up Maya from Lincoln school', 'Collect Maya Lincoln school'],
    ['Maya’s birthday', 'Maya bday party'],
    ['Dinner Alex', 'Dinner with Alex'],
    ['Flight UA 123 to Boston', 'Boston flight UA123'],
    ['Boston rail booking', 'Train to Boston'],
    ['Museum board retreat', 'Board museum retreat planning'],
  ])('matches %s and %s with independent venue and time evidence', (a, b) => {
    const left = event(a, 'family');
    const right = event(b, 'work', { location: 'Sunset Studio\n123 Main Street' });
    const before = structuredClone([left, right]);
    const evidence = calendarEventMatchEvidence(left, right);
    expect(evidence).toMatchObject({
      kind: 'probable',
      signals: expect.arrayContaining(['title', 'venue']),
    });
    expect(calendarEventMatchEvidence(right, left)).toEqual(evidence);
    expect(sameCalendarOccurrence(left, right)).toBe(false);
    expect([left, right]).toEqual(before);
  });

  it('uses exact meeting identity and participants when there is no physical venue', () => {
    const left = event('Apollo sync with Alex', 'work', {
      location: '',
      links: [{ type: 'video', url: 'https://meet.google.com/abc-defg-hij?authuser=1' }],
    });
    const right = event('Alex Apollo catchup', 'personal', {
      location: 'https://meet.google.com/abc-defg-hij',
    });
    expect(calendarEventMatchEvidence(left, right)).toMatchObject({
      kind: 'probable',
      signals: expect.arrayContaining(['meeting-link']),
    });
    const attendees = ['owner@example.test (accepted)', 'alex@example.test (tentative)'];
    expect(
      calendarEventMatchEvidence(
        { ...left, links: [], attendees },
        { ...right, location: '', attendees },
      ),
    ).toMatchObject({ kind: 'probable', signals: expect.arrayContaining(['participants']) });
    expect(
      calendarEventMatchEvidence(
        { ...left, links: [], attendees: [attendees[0]] },
        { ...right, location: '', attendees: [attendees[0]] },
      ),
    ).toBeUndefined();
  });

  it('uses a literal booking reference, not an arbitrary shared website', () => {
    const left = event('Harbor hotel booking', 'travel', {
      location: '',
      description: 'Booking reference: ABC123',
    });
    const right = event('Harbor accommodation', 'family', {
      location: '',
      description: 'Confirmation code: ABC123',
    });
    expect(calendarEventMatchEvidence(left, right)).toMatchObject({
      kind: 'probable',
      signals: expect.arrayContaining(['reference']),
    });
    expect(
      calendarEventMatchEvidence(left, { ...right, description: 'Confirmation code: DEF456' }),
    ).toBeUndefined();
    expect(
      calendarEventMatchEvidence(
        { ...left, description: '', links: [{ url: 'https://hotel.example/' }] },
        { ...right, description: '', links: [{ url: 'https://hotel.example/' }] },
      ),
    ).toBeUndefined();
  });

  it('recognizes provider link variants and explicit venue aliases without inventing either', () => {
    const left = event('Apollo review', 'work', {
      location: '',
      links: [{ url: 'https://us02web.zoom.us/j/123456789?pwd=secret' }],
    });
    const right = event('Apollo review', 'personal', { location: 'https://zoom.us/j/123456789' });
    expect(calendarEventMatchEvidence(left, right)?.kind).toBe('probable');
    expect(
      calendarEventMatchEvidence(left, { ...right, location: 'https://zoom.us/j/987654321' }),
    ).toBeUndefined();
    const entrance = event('Maya piano lesson', 'school', {
      location: 'East Entrance',
      description: 'Venue aliases: East Entrance | West Entrance',
    });
    const alternate = event('Piano class Maya', 'family', { location: 'West Entrance' });
    expect(calendarEventMatchEvidence(entrance, alternate)?.kind).toBe('probable');
    expect(calendarEventMatchEvidence({ ...entrance, description: '' }, alternate)).toBeUndefined();
  });

  it('handles explicit arrival instructions for an appointment without a sports-specific clock', () => {
    const left = event('Dentist Chen', 'family', { start: '2026-11-09T16:30:00Z' });
    const right = event('Dental appointment Dr Chen', 'medical', {
      description: 'Arrival: 30 minutes early',
    });
    expect(calendarEventMatchEvidence(left, right)).toMatchObject({
      kind: 'probable',
      earlierStartMinutes: 30,
      signals: expect.arrayContaining(['arrival-time']),
    });
    expect(calendarEventMatchEvidence(left, { ...right, description: '' })).toMatchObject({
      kind: 'possible',
    });
  });

  it('keeps incomplete matches uncertain instead of asserting a conflict or merging the sources', () => {
    const left = event('Dentist Chen', 'family');
    for (const right of [
      event('Dentist Chen', 'medical', { start: '2026-11-09T17:30:00Z' }),
      event('Dentist Chen', 'medical', { end: '2026-11-09T18:45:00Z' }),
      event('Dentist Chen', 'medical', { location: '' }),
      event('Dentist Chen', 'medical', { originalStartTime: left.start }),
    ])
      expect(calendarEventMatchEvidence(left, right)?.kind).toBe('possible');
    expect(
      calendarEventMatchEvidence(
        { ...left, location: '' },
        event('Dentist Chen', 'medical', { location: '' }),
      )?.kind,
    ).toBe('possible');
  });

  it.each([
    ['Dentist Chen', 'Dentist Smith'],
    ['Design review Alex', 'Design review Sam'],
    ['Design review 1', 'Design review 2'],
    ['Maya piano lesson', 'Liam piano lesson'],
    ['Harbor practice', 'Harbor game'],
    ['Harbor game', 'Harbor fundraiser'],
    ['Lincoln pickup Maya', 'Lincoln dropoff Maya'],
    ['Flight UA123 Boston', 'Flight UA456 Boston'],
    ['Dinner Alex', 'Lunch Alex'],
    ['Dentist Chen', 'Medical Chen'],
  ])('does not conflate distinct activities or people: %s / %s', (a, b) => {
    expect(calendarEventMatchEvidence(event(a, 'family'), event(b, 'work'))).toBeUndefined();
  });

  it('does not suppress genuine conflicts at different venues, rooms or meeting links', () => {
    const left = event('Apollo review', 'work');
    for (const location of ['Other Studio, 123 Main St', 'Sunset Studio, 456 Main St'])
      expect(
        calendarEventMatchEvidence(left, event('Apollo review', 'family', { location })),
      ).toBeUndefined();
    expect(
      calendarEventMatchEvidence(
        { ...left, location: 'Sunset Studio, room 1' },
        event('Apollo review', 'family', { location: 'Sunset Studio, room 2' }),
      ),
    ).toBeUndefined();
    expect(
      calendarEventMatchEvidence(
        { ...left, links: [{ url: 'https://meet.google.com/abc-defg-hij' }] },
        event('Apollo review', 'family', {
          links: [{ url: 'https://meet.google.com/xyz-abcd-efg' }],
        }),
      ),
    ).toBeUndefined();
  });

  it('does not turn generic online locations or a missing event number into a confident match', () => {
    for (const location of ['https://office.example/', 'Google Meet', 'Zoom meeting']) {
      expect(
        calendarEventMatchEvidence(
          event('Design review', 'work', { location }),
          event('Design review', 'family', { location }),
        )?.kind,
      ).toBe('possible');
    }
    expect(
      calendarEventMatchEvidence(event('Design review', 'work'), event('Design review 2', 'family'))
        ?.kind,
    ).toBe('possible');
  });

  it('requires valid, overlapping absolute intervals and compatible occurrences', () => {
    const left = event('Maya piano lesson', 'family');
    for (const extra of [
      { calendarId: 'family' },
      { status: 'cancelled' },
      { allDay: true },
      { start: '2026-11-09T17:00:00' },
      { end: 'invalid' },
      { end: left.start },
      { start: '2026-11-09T18:00:00Z', end: '2026-11-09T19:00:00Z' },
      { start: '2026-11-10T17:00:00Z', end: '2026-11-10T18:00:00Z' },
    ])
      expect(
        calendarEventMatchEvidence(left, event('Maya piano class', 'school', extra)),
      ).toBeUndefined();
    expect(
      calendarEventMatchEvidence(
        { ...left, originalStartTime: left.start },
        event('Maya piano class', 'school', { originalStartTime: '2026-11-10T17:00:00Z' }),
      ),
    ).toBeUndefined();
    expect(
      calendarEventMatchEvidence(
        left,
        event('Maya piano class', 'school', {
          start: '2026-11-09T09:00:00-08:00',
          end: '2026-11-09T10:00:00-08:00',
        }),
      )?.kind,
    ).toBe('probable');
  });
});
