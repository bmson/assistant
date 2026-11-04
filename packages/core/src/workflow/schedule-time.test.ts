import { describe, expect, it } from 'vitest';
import { nextRun } from './schedule-time.js';

describe('nextRun Croner timezone behavior', () => {
  it('places a fixed 02:30 schedule at the first valid time after the spring DST gap', () => {
    // Croner 10 returns 03:30 local here; Croner 11 deliberately returns 03:00.
    expect(
      nextRun('30 2 * * *', 'America/Los_Angeles', new Date('2026-03-08T09:50:00.000Z')),
    ).toEqual(new Date('2026-03-08T10:00:00.000Z'));
    expect(nextRun('30 2 * * *', 'Europe/Berlin', new Date('2026-03-29T00:50:00.000Z'))).toEqual(
      new Date('2026-03-29T01:00:00.000Z'),
    );
  });

  it('runs fixed times once at the first fall-back occurrence in both timezones', () => {
    expect(
      nextRun('30 1 * * *', 'America/Los_Angeles', new Date('2026-11-01T07:50:00.000Z')),
    ).toEqual(new Date('2026-11-01T08:30:00.000Z'));
    expect(
      nextRun('30 1 * * *', 'America/Los_Angeles', new Date('2026-11-01T08:45:00.000Z')),
    ).toEqual(new Date('2026-11-02T09:30:00.000Z'));
    expect(nextRun('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T00:15:00.000Z'))).toEqual(
      new Date('2026-10-25T00:30:00.000Z'),
    );
    expect(nextRun('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T00:45:00.000Z'))).toEqual(
      new Date('2026-10-26T01:30:00.000Z'),
    );
  });

  it('continues interval schedules through the repeated fall-back hour', () => {
    // Croner 10 skips this repeated occurrence and advances to the next day.
    expect(
      nextRun('0,30 1 * * *', 'America/Los_Angeles', new Date('2026-11-01T08:45:00.000Z')),
    ).toEqual(new Date('2026-11-01T09:00:00.000Z'));
    expect(nextRun('0,30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T00:45:00.000Z'))).toEqual(
      new Date('2026-10-25T01:00:00.000Z'),
    );
  });

  it('returns a strictly later occurrence from an exact fixed-time anchor', () => {
    const laAnchor = new Date('2026-11-01T08:30:00.000Z');
    const laNext = nextRun('30 1 * * *', 'America/Los_Angeles', laAnchor);
    expect(laNext.getTime()).toBeGreaterThan(laAnchor.getTime());
    expect(laNext).toEqual(new Date('2026-11-02T09:30:00.000Z'));

    const berlinAnchor = new Date('2026-10-25T00:30:00.000Z');
    const berlinNext = nextRun('30 2 * * *', 'Europe/Berlin', berlinAnchor);
    expect(berlinNext.getTime()).toBeGreaterThan(berlinAnchor.getTime());
    expect(berlinNext).toEqual(new Date('2026-10-26T01:30:00.000Z'));
  });
});
