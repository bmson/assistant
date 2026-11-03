import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { calendarSourceInterval } from './calendar-read-window.js';

const LA = 'America/Los_Angeles';

describe('calendarSourceInterval', () => {
  it('accepts valid timed intervals only when both boundaries carry a valid explicit offset', () => {
    expect(
      calendarSourceInterval({
        start: '2026-10-15T09:00:00-07:00',
        end: '2026-10-15T10:00:00-07:00',
      }),
    ).toEqual({
      start: Date.parse('2026-10-15T16:00:00Z'),
      end: Date.parse('2026-10-15T17:00:00Z'),
    });
    expect(
      calendarSourceInterval({
        start: '2026-10-15T16:00:00Z',
        end: '2026-10-15T17:00:00Z',
      }),
    ).toEqual({
      start: Date.parse('2026-10-15T16:00:00Z'),
      end: Date.parse('2026-10-15T17:00:00Z'),
    });
    expect(
      calendarSourceInterval({
        start: '2026-10-15T09:00:00-07:00',
        end: '2026-10-15T17:00:00Z',
      }),
    ).toEqual({
      start: Date.parse('2026-10-15T16:00:00Z'),
      end: Date.parse('2026-10-15T17:00:00Z'),
    });
  });

  it('leaves complete offsetless timed values unresolved even when a calendar zone is present', () => {
    expect(
      calendarSourceInterval({
        start: '2026-10-15T09:00:00',
        end: '2026-10-15T10:00:00',
        calendarTimeZone: LA,
      }),
    ).toBeUndefined();
  });

  it('leaves offsetless DST fold and gap wall times unresolved', () => {
    expect(
      calendarSourceInterval({
        start: '2026-11-01T01:15:00',
        end: '2026-11-01T01:45:00',
        calendarTimeZone: LA,
      }),
    ).toBeUndefined();
    expect(
      calendarSourceInterval({
        start: '2026-03-08T02:15:00',
        end: '2026-03-08T02:45:00',
        calendarTimeZone: LA,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['impossible calendar date', { start: '2026-02-30T09:00:00Z', end: '2026-02-30T10:00:00Z' }],
    ['impossible wall time', { start: '2026-10-15T25:00:00Z', end: '2026-10-15T26:00:00Z' }],
    [
      'out-of-range offset hour',
      { start: '2026-10-15T09:00:00+25:00', end: '2026-10-15T10:00:00+25:00' },
    ],
    [
      'out-of-range offset minute',
      { start: '2026-10-15T09:00:00+07:60', end: '2026-10-15T10:00:00+07:60' },
    ],
    ['missing end offset', { start: '2026-10-15T09:00:00Z', end: '2026-10-15T10:00:00' }],
    ['missing start offset', { start: '2026-10-15T09:00:00', end: '2026-10-15T10:00:00Z' }],
    [
      'mixed date-only and timed start',
      { start: '2026-10-15', end: '2026-10-15T10:00:00Z', calendarTimeZone: LA },
    ],
    [
      'mixed timed and date-only end',
      { start: '2026-10-15T09:00:00Z', end: '2026-10-16', calendarTimeZone: LA },
    ],
    ['missing end', { start: '2026-10-15T09:00:00Z' }],
    ['missing start', { end: '2026-10-15T10:00:00Z' }],
  ])('rejects %s', (_description, interval) => {
    expect(calendarSourceInterval(interval)).toBeUndefined();
  });

  it('preserves source-zone date-only intervals across DST transitions', () => {
    expect(
      calendarSourceInterval({
        start: '2026-11-01',
        end: '2026-11-02',
        calendarTimeZone: LA,
      }),
    ).toEqual({
      start: Date.parse('2026-11-01T07:00:00Z'),
      end: Date.parse('2026-11-02T08:00:00Z'),
    });
    expect(
      calendarSourceInterval({
        start: '2026-03-08',
        end: '2026-03-09',
        calendarTimeZone: LA,
      }),
    ).toEqual({
      start: Date.parse('2026-03-08T08:00:00Z'),
      end: Date.parse('2026-03-09T07:00:00Z'),
    });
  });

  it('returns the same source intervals under UTC and America/Los_Angeles host TZ settings', () => {
    const script = `
      import { calendarSourceInterval } from './packages/core/src/workflow/calendar-read-window.ts';
      const cases = [
        { start: '2026-10-15T09:00:00-07:00', end: '2026-10-15T10:00:00-07:00' },
        { start: '2026-11-01', end: '2026-11-02', calendarTimeZone: 'America/Los_Angeles' },
        { start: '2026-03-08', end: '2026-03-09', calendarTimeZone: 'America/Los_Angeles' },
        { start: '2026-11-01T01:15:00', end: '2026-11-01T01:45:00', calendarTimeZone: 'America/Los_Angeles' },
        { start: '2026-03-08T02:15:00', end: '2026-03-08T02:45:00', calendarTimeZone: 'America/Los_Angeles' },
      ];
      console.log(JSON.stringify(cases.map(calendarSourceInterval)));
    `;
    const run = (tz: string) => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim()) as unknown;
    };

    expect(run('UTC')).toEqual(run('America/Los_Angeles'));
  });
});
