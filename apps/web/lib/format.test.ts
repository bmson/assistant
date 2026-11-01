import { describe, expect, it } from 'vitest';
import {
  formatFriendlyDateTime,
  formatUsd,
  formatUsdExposure,
  relativeTime,
  stripMarkdown,
  truncate,
} from './format';

// A fixed "now": 2026-07-22 21:30 UTC = 2026-07-22 14:30 in Los Angeles.
const NOW = new Date('2026-07-22T21:30:00Z');
const LA = 'America/Los_Angeles';

describe('formatFriendlyDateTime', () => {
  it('renders same-day times as Today', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-22T16:41:00Z'), LA, NOW)).toBe('Today 9:41 AM');
  });

  it('renders the previous calendar day as Yesterday', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-21T23:02:00Z'), LA, NOW)).toBe(
      'Yesterday 4:02 PM',
    );
  });

  it('respects the timezone when bucketing days', () => {
    // 2026-07-22 02:15 UTC is still 2026-07-21 in Los Angeles — Yesterday there,
    // but Today in UTC.
    const lateNight = new Date('2026-07-22T02:15:00Z');
    expect(formatFriendlyDateTime(lateNight, LA, NOW)).toBe('Yesterday 7:15 PM');
    expect(formatFriendlyDateTime(lateNight, 'UTC', NOW)).toBe('Today 2:15 AM');
  });

  it('renders same-year dates without the year', () => {
    expect(formatFriendlyDateTime(new Date('2026-07-15T16:41:00Z'), LA, NOW)).toBe(
      'Jul 15 · 9:41 AM',
    );
  });

  it('includes the year for other years', () => {
    expect(formatFriendlyDateTime(new Date('2025-07-15T16:41:00Z'), LA, NOW)).toBe(
      'Jul 15, 2025 · 9:41 AM',
    );
  });

  it('falls back to UTC without a timezone, matching formatDateTime behavior', () => {
    expect(formatFriendlyDateTime(new Date('2026-01-03T08:05:00Z'), undefined, NOW)).toBe(
      'Jan 3 · 8:05 AM',
    );
  });
});

describe('stripMarkdown', () => {
  it('flattens the verbatim prod snippet', () => {
    expect(
      stripMarkdown(
        "Here's the official PNPM workspace documentation URL: **PNPM Workspaces Documentation**: 👉 [https://pnpm.io/workspaces](https://pnpm.io/workspaces)",
      ),
    ).toBe(
      "Here's the official PNPM workspace documentation URL: PNPM Workspaces Documentation: 👉 https://pnpm.io/workspaces",
    );
  });

  it('strips headings, lists, quotes, code, and emphasis', () => {
    expect(
      stripMarkdown('# Plan\n\n- **Step one** done\n- `code` bit\n> note\n\n_almost_ there'),
    ).toBe('Plan Step one done code bit note almost there');
  });

  it('turns links into their labels', () => {
    expect(stripMarkdown('See [the tracker](https://example.com/sheet) for status')).toBe(
      'See the tracker for status',
    );
  });

  it('leaves plain text alone', () => {
    expect(stripMarkdown('Filed 3 documents and answered the email.')).toBe(
      'Filed 3 documents and answered the email.',
    );
  });
});

describe('existing helpers stay stable', () => {
  it('relativeTime rounds to the nearest unit', () => {
    expect(relativeTime(new Date(NOW.getTime() - 3 * 60_000), NOW)).toBe('3m ago');
  });

  // Days used to run on forever, so a fact saved in 2024 read "612d ago" — a
  // number you have to divide before it means anything.
  it('relativeTime rolls days up into months and years', () => {
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    expect(relativeTime(daysAgo(29), NOW)).toBe('29d ago');
    expect(relativeTime(daysAgo(45), NOW)).toBe('2mo ago');
    expect(relativeTime(daysAgo(200), NOW)).toBe('7mo ago');
    expect(relativeTime(daysAgo(612), NOW)).toBe('2y ago');
  });

  // 350 days is still under a year but rounds to 12 months; a "12mo" reading
  // would sit awkwardly next to "1y", so months stop at 11.
  it('relativeTime never reports twelve months', () => {
    expect(relativeTime(new Date(NOW.getTime() - 350 * 86_400_000), NOW)).toBe('11mo ago');
  });

  it('relativeTime keeps the future direction across the new units', () => {
    expect(relativeTime(new Date(NOW.getTime() + 400 * 86_400_000), NOW)).toBe('in 1y');
  });

  it('truncate appends a single ellipsis character', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('formatUsd', () => {
  it('renders money with two decimals', () => {
    expect(formatUsd('0.5')).toBe('$0.50');
    expect(formatUsd('0.982')).toBe('$0.98');
    expect(formatUsd('50')).toBe('$50.00');
    expect(formatUsd('0')).toBe('$0.00');
  });

  it('keeps sub-cent precision so single model calls stay visible', () => {
    expect(formatUsd('0.0055')).toBe('$0.0055');
    expect(formatUsd('0.0001')).toBe('$0.0001');
  });

  it('falls back to zero for missing or unparseable values', () => {
    expect(formatUsd(null)).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUsd('not-a-number')).toBe('$0.00');
  });
});

describe('formatUsdExposure', () => {
  it('keeps the smallest stored positive estimate visible', () => {
    expect(formatUsdExposure('0.000001')).toBe('$0.000001');
    expect(formatUsdExposure('0.000004')).toBe('$0.000004');
    expect(formatUsdExposure('0.005500')).toBe('$0.0055');
    expect(formatUsdExposure('0.375000')).toBe('$0.38');
  });
});
