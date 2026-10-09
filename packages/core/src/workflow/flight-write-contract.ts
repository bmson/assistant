import type { ActionEvidence } from './response-contract.js';
import { explicitWriteInstants } from './write-grounding.js';

export interface FlightWriteCorrection {
  text: string;
  changed: boolean;
  flightUpdateReceipt?: string;
}

interface FlightFacts {
  carriers: Set<string>;
  locations: Set<string>;
  flightNumbers: Set<string>;
  instants: Set<number>;
  utcMinutes: Set<number>;
  localMinutes: Set<number>;
  dates: Set<string>;
  hasArrival: boolean;
  hasReturn: boolean;
}

interface FlightWrite {
  item: ActionEvidence;
  source: string;
  facts: FlightFacts;
}

type Dict = Record<string, unknown>;

const AIRLINES: Array<[string, RegExp]> = [
  ['UA', /\bunited\b(?!\s+states\b)|\bunited\s+airlines\b/i],
  ['AA', /\bamerican\s+airlines\b/i],
  ['DL', /\bdelta(?:\s+air\s+lines)?\b/i],
  ['KL', /\bklm\b/i],
  ['LH', /\blufthansa\b/i],
  ['BA', /\bbritish\s+airways\b/i],
  ['AF', /\bair\s+france\b/i],
  ['AS', /\balaska\s+airlines\b/i],
  ['B6', /\bjetblue\b/i],
  ['EK', /\bemirates\b/i],
];

const AIRPORT_STOP_WORDS = new Set([
  'AM',
  'ARR',
  'CET',
  'CEST',
  'DEP',
  'EDT',
  'EST',
  'EUR',
  'GBP',
  'GMT',
  'KLM',
  'PDT',
  'PST',
  'UTC',
  'USD',
  'USA',
]);
const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  PST: -8,
  PDT: -7,
  MST: -7,
  MDT: -6,
  CST: -6,
  CDT: -5,
  EST: -5,
  EDT: -4,
  CET: 1,
  CEST: 2,
};
const FLIGHT_CONTEXT = /\b(?:flight|itinerary|airline|boarding|departure|arrival|airport)\b/i;
const MISSING_RETURN =
  /\b(?:(?:return)(?:\s+(?:flight|time|times|details))?[^.!?\n]{0,70}\b(?:unavailable|not\s+available|unknown|missing|couldn['’]t|can['’]t|cannot|no\b)|no\s+return(?:\s+(?:flight|time|times|details))?)\b/i;
const MISSING_ARRIVAL =
  /\b(?:(?:arrival)(?:\s+(?:time|times|details))?[^.!?\n]{0,70}\b(?:unavailable|not\s+available|unknown|missing|couldn['’]t|can['’]t|cannot|no\b)|no\s+arrival(?:\s+(?:time|times|details))?)\b/i;
const TIME_WITH_ZONE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(?:(a\.?m\.?|p\.?m\.?)\s*)?(UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CEST|CET)\b/gi;
const MONTH_DATE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi;

function record(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
}

function successful(item: ActionEvidence): boolean {
  if (item.status !== 'succeeded' || item.fromCurrentTask === false) return false;
  const result = record(item.result);
  return result.ok !== false && !(typeof result.status === 'number' && result.status >= 400);
}

function writeSource(item: ActionEvidence): string {
  const args = record(item.args);
  if (item.toolName === 'calendar.create_event') {
    return JSON.stringify([args.summary, args.description, args.location, args.start, args.end]);
  }
  if (item.toolName === 'calendar.update_event') {
    const result = record(item.result);
    if (result.updated !== true) return '';
    // Patch input is intent, not proof. Only fields returned by Calendar can
    // support the final schedule; absent canonical time suppresses stale claims.
    return JSON.stringify([result.start]);
  }
  if (item.toolName === 'sheets.create') {
    return JSON.stringify([args.title, args.sheetName, args.rows]);
  }
  if (item.toolName === 'sheets.append_rows' || item.toolName === 'sheets.write_rows') {
    return JSON.stringify(args);
  }
  return '';
}

function utcMinute(hour: number, minute: number, zone: string): number | undefined {
  const offset = ZONE_OFFSETS[zone.toUpperCase()];
  if (offset === undefined || hour > 23 || minute > 59) return undefined;
  return (((hour * 60 + minute - offset * 60) % 1440) + 1440) % 1440;
}

function dateParts(
  value: string,
  fallbackYear: number,
): { year: number; month: number; day: number } | undefined {
  const match = MONTH_DATE.exec(value);
  MONTH_DATE.lastIndex = 0;
  if (!match) return undefined;
  const month = new Date(`${match[1]} 1, 2000`).getUTCMonth();
  const day = Number(match[2]);
  const year = Number(match[3] ?? fallbackYear);
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

function temporalFacts(
  value: string,
  referenceAt: Date,
): Pick<FlightFacts, 'instants' | 'utcMinutes' | 'localMinutes' | 'dates'> {
  const instants = new Set(explicitWriteInstants(value, referenceAt));
  const utcMinutes = new Set<number>();
  const localMinutes = new Set<number>();
  const dates = new Set<string>();
  const fallbackYear = referenceAt.getUTCFullYear();
  for (const match of value.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))
    dates.add(`${match[1]}-${match[2]}-${match[3]}`);
  for (const match of value.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)) {
    const rawHour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = (match[3] ?? '').toLowerCase();
    const hour = meridiem ? (rawHour % 12) + (meridiem.startsWith('p') ? 12 : 0) : rawHour;
    if (hour <= 23 && minute <= 59) localMinutes.add(hour * 60 + minute);
  }
  for (const match of value.matchAll(TIME_WITH_ZONE)) {
    const rawHour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const meridiem = (match[3] ?? '').toLowerCase();
    const hour = meridiem ? (rawHour % 12) + (meridiem.startsWith('p') ? 12 : 0) : rawHour;
    const zone = (match[4] ?? '').toUpperCase();
    const minuteOfDay = utcMinute(hour, minute, zone);
    if (minuteOfDay !== undefined) utcMinutes.add(minuteOfDay);
  }
  for (const instant of instants) {
    const parsed = new Date(instant);
    dates.add(parsed.toISOString().slice(0, 10));
    utcMinutes.add(parsed.getUTCHours() * 60 + parsed.getUTCMinutes());
  }
  for (const match of value.matchAll(MONTH_DATE)) {
    const parsed = dateParts(match[0], fallbackYear);
    if (parsed)
      dates.add(
        new Date(Date.UTC(parsed.year, parsed.month, parsed.day)).toISOString().slice(0, 10),
      );
  }
  MONTH_DATE.lastIndex = 0;
  return { instants, utcMinutes, localMinutes, dates };
}

function normalizedFacts(source: string, item: ActionEvidence): FlightFacts {
  const args = record(item.args);
  const result = record(item.result);
  const updateNames =
    item.toolName === 'calendar.update_event'
      ? ` ${String(result.summary ?? '')} ${String(result.description ?? '')} ${String(result.location ?? '')}`
      : '';
  const names = `${source} ${String(args.summary ?? '')} ${String(args.description ?? '')}${updateNames}`;
  const carriers = new Set(
    AIRLINES.filter(([, pattern]) => pattern.test(names)).map(([code]) => code),
  );
  const flightNumbers = new Set<string>();
  for (const match of names.matchAll(/\b(UA|AA|DL|KL|LH|BA|AF|AS|B6|EK)\s*\d{1,4}\b/gi)) {
    const full = (match[0] ?? '').replace(/\s+/g, '').toUpperCase();
    flightNumbers.add(full);
    carriers.add(full.match(/^[A-Z]+/)?.[0] ?? '');
  }
  const locations = new Set(
    (source.match(/\b[A-Z]{3}\b/g) ?? []).filter((code) => !AIRPORT_STOP_WORDS.has(code)),
  );
  const reference = typeof args.start === 'string' ? new Date(args.start) : new Date(0);
  const temporal = temporalFacts(
    source,
    Number.isNaN(reference.getTime()) ? new Date(0) : reference,
  );

  // An outbound description can mention a missing return without being a return leg.
  const returnLabel =
    item.toolName === 'calendar.create_event' ? String(args.summary ?? '') : source;
  const isReturn =
    /\breturn(?:\s+flight)?\b/i.test(returnLabel) &&
    !MISSING_RETURN.test(returnLabel) &&
    !/\breturn\b[^.!?\n]{0,70}\b(?:not\s+(?:booked|scheduled|confirmed)|pending|unbooked)\b/i.test(
      returnLabel,
    );
  const hasArrival =
    item.toolName === 'calendar.create_event'
      ? typeof args.end === 'string' && args.end.length > 0
      : /\barrival\b/i.test(source);
  const hasReturn =
    isReturn &&
    (typeof args.start === 'string' ||
      /\breturn\b[^\n]{0,80}(?:\d{1,2}:\d{2}|20\d{2}-\d{2}-\d{2})/i.test(source));
  return { carriers, locations, flightNumbers, ...temporal, hasArrival, hasReturn };
}

function flightWrites(evidence: ActionEvidence[], requestText: string): FlightWrite[] {
  return evidence.flatMap((item) => {
    if (!successful(item)) return [];
    const source = writeSource(item);
    if (!source) return [];
    const args = record(item.args);
    const result = record(item.result);
    const target = [
      args.summary,
      args.description,
      args.location,
      result.summary,
      result.description,
      result.location,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (item.toolName === 'calendar.update_event' && !FLIGHT_CONTEXT.test(target)) return [];
    if (
      !FLIGHT_CONTEXT.test(requestText) &&
      !FLIGHT_CONTEXT.test(source) &&
      !FLIGHT_CONTEXT.test(target)
    )
      return [];
    return [{ item, source, facts: normalizedFacts(source, item) }];
  });
}

function claimedFacts(sentence: string, referenceAt: Date): FlightFacts {
  const carriers = new Set(
    AIRLINES.filter(([, pattern]) => pattern.test(sentence)).map(([code]) => code),
  );
  const flightNumbers = new Set<string>();
  for (const match of sentence.matchAll(/\b(UA|AA|DL|KL|LH|BA|AF|AS|B6|EK)\s*\d{1,4}\b/gi)) {
    const value = (match[0] ?? '').replace(/\s+/g, '').toUpperCase();
    flightNumbers.add(value);
    carriers.add(value.match(/^[A-Z]+/)?.[0] ?? '');
  }
  const locations = new Set<string>();
  for (const match of sentence.matchAll(
    /\b(?:from|to|via|at|airport(?:\s+code)?)\s+([A-Z]{3})\b/g,
  )) {
    const code = match[1] ?? '';
    if (!AIRPORT_STOP_WORDS.has(code)) locations.add(code);
  }
  for (const match of sentence.matchAll(/\b([A-Z]{3})\s*(?:→|->|–|—|-)\s*([A-Z]{3})\b/g)) {
    for (const code of [match[1], match[2]])
      if (code && !AIRPORT_STOP_WORDS.has(code)) locations.add(code);
  }
  const temporal = temporalFacts(sentence, referenceAt);
  return {
    carriers,
    locations,
    flightNumbers,
    ...temporal,
    hasArrival: false,
    hasReturn: false,
  };
}

function contradicts(sentence: string, writes: FlightWrite[]): boolean {
  if (MISSING_ARRIVAL.test(sentence) && writes.some((write) => write.facts.hasArrival)) return true;
  if (MISSING_RETURN.test(sentence) && writes.some((write) => write.facts.hasReturn)) return true;
  const flightClaim =
    FLIGHT_CONTEXT.test(sentence) ||
    MISSING_RETURN.test(sentence) ||
    MISSING_ARRIVAL.test(sentence);
  if (!flightClaim) return false;
  const referenceAt =
    writes
      .map((write) => {
        const start = record(write.item.args).start;
        return typeof start === 'string' ? new Date(start) : new Date(Number.NaN);
      })
      .find((date) => !Number.isNaN(date.getTime())) ?? new Date(0);
  const claimed = claimedFacts(sentence, referenceAt);
  const hasSpecificClaim =
    claimed.carriers.size +
      claimed.locations.size +
      claimed.flightNumbers.size +
      claimed.instants.size +
      claimed.utcMinutes.size +
      claimed.localMinutes.size +
      claimed.dates.size >
    0;
  if (!hasSpecificClaim) return false;
  return !writes.some(({ facts, item }) => {
    const setSupported = <T>(values: Set<T>, support: Set<T>) =>
      [...values].every((value) => support.has(value));
    return (
      setSupported(claimed.carriers, facts.carriers) &&
      setSupported(claimed.locations, facts.locations) &&
      setSupported(claimed.flightNumbers, facts.flightNumbers) &&
      setSupported(claimed.instants, facts.instants) &&
      setSupported(claimed.utcMinutes, facts.utcMinutes) &&
      (item.toolName !== 'calendar.update_event' ||
        setSupported(claimed.localMinutes, facts.localMinutes)) &&
      setSupported(claimed.dates, facts.dates)
    );
  });
}

function receipts(writes: FlightWrite[]): string {
  return writes
    .map(({ item }) => {
      const args = record(item.args);
      if (item.toolName === 'calendar.create_event') {
        const summary = typeof args.summary === 'string' ? args.summary : 'flight event';
        const start = typeof args.start === 'string' ? args.start : '(start unavailable)';
        const end = typeof args.end === 'string' ? args.end : '(end unavailable)';
        return `Saved to your calendar: “${summary}”, ${start} to ${end}.`;
      }
      if (item.toolName === 'calendar.update_event') {
        const start = record(item.result).start;
        if (typeof start !== 'string')
          return "The calendar accepted the flight-time update, but its response did not include the updated departure, so I couldn't confirm the final schedule.";
        return `Updated the calendar flight departure to ${start}.`;
      }
      const title = typeof args.title === 'string' ? args.title : 'flight spreadsheet';
      const url = record(item.result).spreadsheetUrl;
      return `Created spreadsheet: “${title}”${typeof url === 'string' ? ` (${url})` : ''}.`;
    })
    .join('\n');
}

/** Correct only a flight sentence that contradicts successful current-task flight writes. */
export function correctFlightWriteClaims(
  text: string,
  evidence: ActionEvidence[],
  requestText: string,
  repetitionRequested = false,
): FlightWriteCorrection {
  if (repetitionRequested || /\brepeat\s+(?:this\s+)?exactly\b/i.test(requestText))
    return { text, changed: false };
  const writes = flightWrites(evidence, requestText);
  if (writes.length === 0) return { text, changed: false };
  const flightUpdateWrites = writes.filter(
    (write) => write.item.toolName === 'calendar.update_event',
  );
  if (flightUpdateWrites.length > 0) {
    const flightUpdateReceipt = receipts(flightUpdateWrites);
    return {
      text: flightUpdateReceipt,
      changed: text.trim() !== flightUpdateReceipt.trim(),
      flightUpdateReceipt,
    };
  }
  const receipt = receipts(writes);
  let changed = false;
  let inserted = false;
  const corrected = text
    .split('\n')
    .map((line) => {
      const sentences = line.match(/[^.!?]+[.!?]?/g);
      if (!sentences) return line;
      return sentences
        .map((sentence) => {
          if (!contradicts(sentence, writes)) return sentence;
          changed = true;
          if (inserted) return '';
          inserted = true;
          return `${receipt}\n`;
        })
        .join('');
    })
    .join('\n');
  return { text: corrected, changed };
}
