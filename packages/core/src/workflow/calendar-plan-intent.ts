export interface CalendarPlanOptions {
  focusMinutes: number;
  slotCount: number;
  breakMinutes: number;
  windowLabel: string;
  workingDays?: number;
  meetingBufferMinutes?: number;
}
const numbers: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
function count(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = numbers[value.toLowerCase()] ?? Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : undefined;
}
/** Only bounded read-only focus proposals; write requests remain ordinary action planning. */
export function requestedCalendarPlanOptions(text: string): CalendarPlanOptions | undefined {
  const positive = text.replace(/\b(?:do\s+not|don['’]?t|never)\b[^.!?;\n]*/gi, '');
  if (
    !/\b(?:calendar|schedule)\b/i.test(positive) ||
    !/\bfocus\s+(?:blocks?|time)\b/i.test(positive)
  )
    return undefined;
  if (/\b(?:create|add|book|schedule|move)\s+(?:\w+\s+){0,3}focus\b/i.test(positive))
    return undefined;
  const nextWeek = /\b(?:next|coming|following)\s+week\b/i.test(positive);
  const days =
    /\bnext\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:working|work|business)\s+days\b/i.exec(
      positive,
    );
  const workingDays = count(days?.[1]);
  if (!nextWeek && !workingDays) return undefined;
  const duration = /\b(\d{2,3})[ -]minute\s+focus\s+blocks?\b/i.exec(positive);
  const focusMinutes = duration ? Number(duration[1]) : 90;
  if (!Number.isInteger(focusMinutes) || focusMinutes < 15 || focusMinutes > 240) return undefined;
  const slots =
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\d{2,3}[ -]minute\s+)?focus\s+blocks?\b/i.exec(
      positive,
    );
  const slotCount = slots ? count(slots[1]) : 3;
  if (!slotCount) return undefined;
  const breaks = /\b(\d{1,2})[ -]minute\s+breaks?\b/i.exec(positive);
  const breakMinutes = breaks ? Number(breaks[1]) : 15;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 60) return undefined;
  return {
    focusMinutes,
    slotCount,
    breakMinutes,
    windowLabel: workingDays ? `the next ${workingDays} working days` : 'next week',
    ...(workingDays ? { workingDays } : {}),
    ...(breaks && /\bbreaks?\s+around\s+(?:meetings?|appointments?|events?)\b/i.test(positive)
      ? { meetingBufferMinutes: breakMinutes }
      : {}),
  };
}
