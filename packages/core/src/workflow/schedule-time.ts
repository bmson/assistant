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
