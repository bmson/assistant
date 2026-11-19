import { createHash } from 'node:crypto';

const HISTORY_MS = 7 * 24 * 60 * 60_000;
const LIMIT = 512;
const HASH = /^[a-f0-9]{64}$/;

export interface CalendarRecoveryObservation {
  event: string;
  moment: string;
  matchingFact?: string;
  kind: 'cancelled' | 'moved';
  observedAt: number;
}

export interface CalendarRecoveryHistory {
  reads: number[];
  observations: CalendarRecoveryObservation[];
}

export function calendarRecoveryCursor(agentId: string): string {
  return `calendar-recovery-v1:${agentId}`;
}

export function calendarRecoveryHash(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function isCalendarObservationDate(value: string): boolean {
  return (
    (/^\d{4}-\d{2}-\d{2}$/.test(value) || /(?:Z|[+-]\d\d:\d\d)$/i.test(value)) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Exact offset-bearing start and title. A date alone is insufficient. */
export function calendarRecoveryFact(
  kind: string,
  title: string,
  start: string,
): string | undefined {
  const name = title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!name || !/(?:Z|[+-]\d\d:\d\d)$/i.test(start)) return;
  const instant = Date.parse(start);
  if (Number.isFinite(instant)) return calendarRecoveryHash(kind, name, String(instant));
}

export function parseCalendarRecovery(
  raw: unknown,
  fence: string | null,
): CalendarRecoveryHistory | null {
  if (typeof raw !== 'string' || raw.length > 200_000) return null;
  try {
    const data = JSON.parse(raw) as CalendarRecoveryHistory & { fence: string | null };
    if (data?.fence !== fence || !Array.isArray(data.reads) || !Array.isArray(data.observations))
      return null;
    return {
      reads: data.reads.filter((time) => Number.isSafeInteger(time) && time > 0).slice(0, LIMIT),
      observations: data.observations
        .filter(
          (item) =>
            item &&
            (item.kind === 'cancelled' || item.kind === 'moved') &&
            HASH.test(item.moment) &&
            HASH.test(item.event) &&
            (item.matchingFact === undefined ||
              (typeof item.matchingFact === 'string' && HASH.test(item.matchingFact))) &&
            Number.isSafeInteger(item.observedAt) &&
            item.observedAt > 0,
        )
        .slice(0, LIMIT),
    };
  } catch {
    return null;
  }
}

export function mergeCalendarRecovery(
  raw: unknown,
  fence: string | null,
  at: Date,
  complete: boolean,
  observations: readonly CalendarRecoveryObservation[],
): string {
  const previous = parseCalendarRecovery(raw, fence);
  const cutoff = at.getTime() - HISTORY_MS;
  const existing = new Map<string, CalendarRecoveryObservation>();
  for (const item of [...(previous?.observations ?? []), ...observations]) {
    if (item.observedAt <= cutoff) continue;
    const prior = existing.get(item.moment);
    if (!prior || prior.observedAt > item.observedAt) existing.set(item.moment, item);
  }
  const reads = new Set(previous?.reads.filter((read) => read > cutoff));
  if (complete) reads.add(at.getTime());
  return JSON.stringify({
    fence,
    reads: [...reads].sort((a, b) => b - a).slice(0, LIMIT),
    observations: [...existing.values()]
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, LIMIT),
  });
}
