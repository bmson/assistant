import { describe, expect, it } from 'vitest';
import { savedNoteCreatedLabel, savedNoteValidityLabel } from './saved-note-date-display';

describe('saved note date display', () => {
  const now = new Date('2026-01-05T00:00:00.000Z');
  const validDate = new Date('2026-01-02T12:00:00.000Z');

  it.each([
    ['finite Date', validDate, '3d ago'],
    ['numeric timestamp', validDate.getTime(), 'Date unavailable'],
    ['string timestamp', validDate.toISOString(), 'Date unavailable'],
    ['undefined timestamp', undefined, 'Date unavailable'],
    ['invalid Date', new Date(Number.NaN), 'Date unavailable'],
  ])('formats created date from %s without coercion', (_label, value, expected) => {
    expect(savedNoteCreatedLabel(value, now)).toBe(expected);
  });

  it.each([
    ['both null', null, null, ''],
    ['valid bounds', validDate, new Date('2026-01-04T00:00:00.000Z'), '2026-01-02–2026-01-04'],
    ['open end', validDate, null, '2026-01-02–now'],
    [
      'bad start with known end',
      new Date(Number.NaN),
      new Date('2026-01-04T00:00:00.000Z'),
      'date unavailable–2026-01-04',
    ],
    ['known start with bad end', validDate, new Date(Number.NaN), '2026-01-02–date unavailable'],
    ['undefined bounds', undefined, undefined, 'date unavailable–date unavailable'],
    [
      'numeric bounds',
      validDate.getTime(),
      validDate.getTime(),
      'date unavailable–date unavailable',
    ],
    [
      'string bounds',
      validDate.toISOString(),
      validDate.toISOString(),
      'date unavailable–date unavailable',
    ],
  ])('formats validity for %s', (_label, from, until, expected) => {
    expect(savedNoteValidityLabel(from, until)).toBe(expected);
  });
});
