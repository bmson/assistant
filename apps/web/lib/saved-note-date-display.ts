import { relativeTime } from '@/lib/format';

function finiteDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function isoDay(value: unknown): string | null {
  const date = finiteDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

export function savedNoteCreatedLabel(value: unknown, now: Date): string {
  const date = finiteDate(value);
  return date ? relativeTime(date, now) : 'Date unavailable';
}

export function savedNoteValidityLabel(validFrom: unknown, validUntil: unknown): string {
  if (validFrom === null && validUntil === null) return '';
  const from = isoDay(validFrom);
  const until = validUntil === null ? 'now' : (isoDay(validUntil) ?? 'date unavailable');
  return `${from ?? 'date unavailable'}–${until}`;
}
