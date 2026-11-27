import { Cron } from 'croner';

/** Compute the next strictly later occurrence, including exact cron boundaries. */
export function nextRun(cron: string, timezone: string, from: Date = new Date()): Date {
  const expression = new Cron(cron, { timezone });
  let next = expression.nextRun(from);
  if (next && next.getTime() <= from.getTime()) {
    next = expression.nextRun(new Date(from.getTime() + 1_000));
  }
  if (!next) throw new Error(`cron never fires: ${cron}`);
  return next;
}

/** The agent-local calendar date and hour of a moment — dedupe granularity. */
export function zonedParts(timeZone: string, at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** The tz's offset-from-UTC at a moment, measured through Intl. */
function zonedOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Agent-local midnight of `at`'s calendar day, as a Date (DST-edge tolerant). */
export function startOfZonedDay(timeZone: string, at: Date): Date {
  const { date } = zonedParts(timeZone, at);
  const guess = Date.parse(`${date}T00:00:00Z`);
  let start = guess - zonedOffsetMs(timeZone, new Date(guess));
  start = guess - zonedOffsetMs(timeZone, new Date(start));
  return new Date(start);
}
