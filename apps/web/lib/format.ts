// Server-side display formatting shared by the dashboard, approvals, and tasks pages.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Rollup thresholds. Days stop being a unit people can read somewhere around a
// month — "612d ago" is a number you have to divide before it means anything —
// so the scale continues into months and years. 30/365-day months and years are
// deliberately approximate: this is the fuzzy half of a timestamp, and callers
// that need the real calendar date pair it with formatFriendlyDateTime.
const MONTH = DAY * 30;
const YEAR = DAY * 365;

/** "3m ago" / "in 2h" / "5mo ago" / "2y ago" / "just now". Server-rendered only. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff <= 0 ? 'just now' : 'in <1m';
  const unit =
    abs < HOUR
      ? `${Math.round(abs / MINUTE)}m`
      : abs < DAY
        ? `${Math.round(abs / HOUR)}h`
        : abs < MONTH
          ? `${Math.round(abs / DAY)}d`
          : abs < YEAR
            ? `${Math.min(11, Math.round(abs / MONTH))}mo`
            : `${Math.round(abs / YEAR)}y`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

/**
 * Compact timestamp "2026-07-15 09:41" in the owner's timezone. The sv-SE locale
 * renders ISO-style YYYY-MM-DD HH:mm; pass the agent's stored timezone so the
 * owner sees local time (dates were 7–8h off when this rendered UTC). Falls back
 * to UTC only if no timezone is given.
 */
export function formatDateTime(date: Date, timeZone?: string): string {
  if (!timeZone) return date.toISOString().slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Friendly timestamp for owner-facing surfaces: "Today 9:41 AM", "Yesterday
 * 4:02 PM", "Jul 15 · 9:41 AM", and "Jul 15, 2025 · 9:41 AM" once the year
 * differs. Keep `formatDateTime` for technical contexts (task timelines,
 * approval expiry parentheticals) where the compact ISO form scans better.
 * Falls back to UTC like `formatDateTime` when no timezone is given.
 */
export function formatFriendlyDateTime(
  date: Date,
  timeZone?: string,
  now: Date = new Date(),
): string {
  const tz = timeZone ?? 'UTC';
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  // en-CA gives YYYY-MM-DD — a sortable per-timezone calendar-day key.
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const day = dayKey(date);
  const today = dayKey(now);
  if (day === today) return `Today ${time}`;
  if (day === dayKey(new Date(now.getTime() - DAY))) return `Yesterday ${time}`;
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  }).format(date);
  return `${dayLabel} · ${time}`;
}

/**
 * "$0.50" — numeric strings from drizzle rendered as money. Two decimals is the
 * form people read prices in; trimming trailing zeros produced "$0.5" and
 * "$0.982" side by side. Sub-cent amounts are the exception: a single model call
 * costs less than a cent, and rounding those to "$0.00" would erase the number
 * the costs page exists to show, so they keep up to 4 decimal places.
 */
export function formatUsd(value: string | null | undefined): string {
  const n = Number.parseFloat(value ?? '0');
  if (Number.isNaN(n)) return '$0.00';
  if (n !== 0 && Math.abs(n) < 0.01) {
    return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  }
  return `$${n.toFixed(2)}`;
}

/** Keep all stored microdollars visible when showing a retained estimate. */
export function formatUsdExposure(value: string | null | undefined): string {
  const n = Number(value ?? '0');
  if (!Number.isFinite(n)) return '$0.00';
  if (n !== 0 && Math.abs(n) < 0.01) {
    return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  }
  return formatUsd(value);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Flatten markdown to plain text for one-line snippets (task progress rows).
 * Task.progress strings come straight from model output, so Home was showing
 * literal `**bold**`/`[label](url)` syntax. Not a full parser — just the
 * constructs models actually emit in progress lines.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/([*_])(?=\S)([^*_]*\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}
