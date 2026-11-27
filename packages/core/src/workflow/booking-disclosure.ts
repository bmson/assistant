import type { ModelMessage } from 'ai';

// Scope this projection to owner-authored booking lookups. It does not grant a
// tool permission, and source text cannot opt the current turn into disclosure.
const BOOKING =
  /\b(?:bookings?|reservations?|check[- ]?in|check[- ]?out|itinerary|boarding pass)\b/i;
const OWNER_BOOKING =
  /\b(?:my|our)\b[^.!?\n]{0,100}\b(?:bookings?|reservations?|hotel|lodging|accommodation|check[- ]?in|check[- ]?out|itinerary|inbox|email)\b/i;
const NAMED_MAIL_READ =
  /\b(?:read|open|find|check|search|look up)\b[^.!?\n]{0,100}\b(?:confirmation|booking|reservation)\s+(?:e-?mail|message|thread)\b/i;
// Each match ends at a supported value. The surrounding prose never becomes
// evidence just because a field name or a time appeared somewhere in it.
const MONTH = `(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\s+${MONTH}\.?\s+\d{4})`;
const CLOCK = String.raw`(?:(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight)`;
const ZONE = String.raw`(?:[+-]\d{2}:\d{2}|Z\b|\s+(?:UTC|GMT|[ECMP][DS]T)\b)`;
const DATE_TIME = String.raw`(?:${DATE}(?:(?:\s+at\s+|\s+|T)${CLOCK})?|${CLOCK})(?:${ZONE})?(?![\p{L}\p{N}:])`;
const TIME_FIELD = new RegExp(
  String.raw`\b(?:check[- ]?(?:in|out)|departure|arrival|departs?|arrives?)\s*(?:(?:is|starts|opens|closes)\s+)?(?:(?:at|on|from|by|until|after)\s+|[:–—-]\s*)?${DATE_TIME}`,
  'iu',
);
const PROPERTY_NAME =
  /^[\p{Lu}\p{N}][\p{L}\p{N}'’&.-]*(?:[ \t]+[\p{Lu}\p{N}][\p{L}\p{N}'’&.-]*){0,7}$/u;
const PROPERTY_SUFFIX =
  /^(?:[\p{Lu}\p{N}][\p{L}\p{N}'’&.-]*[ \t]+){0,7}(?:Hotel|Inn|Resort|Suites|Apartments)\b/u;
const EVENT_LABEL = /\b(?:check[- ]?(?:in|out)|departure|arrival)\b/i;
const BOOKING_HEADING =
  /\b(?:(?:booking|reservation) (?:confirmation|confirmed|cancelled|canceled|rescheduled)|itinerary)\b/i;
const BOOKING_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/;
const BOOKING_FIELDS: ReadonlyArray<[RegExp, RegExp]> = [
  [
    /^(?:(?:hotel|property) )?address\s*:\s*/i,
    /^\d{1,6}[A-Za-z]?\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}'’.-]*\s+){1,7}?(?:[Aa]ve(?:nue)?|[Ss]t(?:reet)?|[Rr](?:oad|d)|[Dd]r(?:ive)?|[Ll](?:ane|n)|[Bb](?:oulevard|lvd)|[Ww]ay|[Cc](?:ourt|t)|[Pp]lace|[Tt]errace)\b\.?/u,
  ],
  [
    /^(?:booking|reservation|confirmation) (?:reference|number|code|id)\s*:\s*/i,
    /^(?:(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{2,39}|[A-Z]{4,12})(?![\w-])/,
  ],
  [/^flight(?: number)?(?:\s*:\s*|\s+)/i, /^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?\b/i],
  [/^(?:gate|terminal|room number)\s*:\s*/i, /^[A-Z]?\d{1,5}[A-Z]?\b/i],
  [/^(?:duration|stay length)\s*:\s*/i, /^\d{1,3}\s+nights?\b/i],
  [
    /^room type\s*:\s*/i,
    /^(?:(?:standard|deluxe|superior|accessible|family)\s+)?(?:single|double|twin|queen|king|suite|studio)(?:\s+room)?\b/i,
  ],
];
const BOOKING_CONTEXT =
  /\b(?:follows?|precedes?|because|due to|in connection with)\b|\b(?:after|before)\s+(?:the|an?|my|our|your)\b/i;
const LODGING = /\b(?:hotel|lodging|accommodation)\b/i;
const HEALTH =
  /\b(?:health|medical|diagnos(?:is|ed)|prescriptions?|medication|therapy|therapist|patient|clinic|doctor|pregnan\w*|fertility|allerg\w*|HIV|A1c|oncology|chemotherapy|asthma|surger(?:y|ies)|surgical|disabilit\w*)\b/i;
const INTIMATE =
  /\b(?:intimate|sexual\w*|affairs?|mistress|sex|libido|bedroom preference|dating history|relationship counselling|relationship counseling|private partner)\b/i;
const FINANCES =
  /\b(?:financ\w*|bank\w*|credit|debit|mortgage|loan|salary|income|debt|balances?|billing|invoices?|payments?|paid|charged?|charges?|refund\w*|deposit\w*|costs?|amount|price|fees?|installments?|tax(?:es)?|USD|EUR|GBP|CAD|ISK)\b|[$€£¥]\s*\d/i;
const DEPOSIT_QUESTION =
  /\b(?:what (?:is|was)|what was charged for|how much (?:is|was)|(?:tell|show) me|verify)\s+(?:what\s+)?(?:the |my |our )?(?:hotel |booking |security )?deposit\b/i;
const DEPOSIT_FACT =
  /^(?:(?:the|a|your|hotel|booking|reservation|security|refundable|required)\s+)*deposit\s*(?:(?:was|is|of|charged|paid)\s+)*[:=–—-]?\s*(?:[$€£]\s*\d[\d,.]*|(?:USD|EUR|GBP|CAD|ISK)\s+\d[\d,.]*|\d[\d,.]*\s+(?:USD|EUR|GBP|CAD|ISK))(?:[.!])?$/i;
const TEXT_FIELDS = new Set([
  'text',
  'subject',
  'snippet',
  'body',
  'summary',
  'description',
  'title',
  'label',
  'detail',
  'name',
  'from',
  'fromName',
  'fromEmail',
  'to',
  'quote',
  'value',
  'content',
  'what',
  'notes',
  'reason',
  'excerpt',
  'message',
  'query',
  'location',
  'sourceLabel',
  'accessibilityLabel',
  'subtitle',
  'lead',
  'locationName',
  'address',
  'display',
  'calendarLabel',
  'error',
  'preview',
  'chunk',
  'note',
  'evidenceQuote',
  'statusEvidence',
]);

export function bookingDisclosure(ownerText: string): { depositRequested: boolean } | undefined {
  if (!bookingMailTitle(ownerText)) return undefined;
  if (!OWNER_BOOKING.test(ownerText) && !NAMED_MAIL_READ.test(ownerText)) return undefined;
  if (
    !/\b(?:what|which|where|when|how|find|look|show|tell|confirm|check|read|verify|summari[sz]e|save|make|create)\b/i.test(
      ownerText,
    )
  )
    return undefined;
  if (
    /\b(?:send|forward|email)\s+(?:it|them|him|her|the details)\b|\b(?:template|examples?|samples?)\b/i.test(
      ownerText,
    )
  )
    return undefined;
  return {
    depositRequested:
      DEPOSIT_QUESTION.test(ownerText) &&
      !/\b(?:exclude|omit|without|ignore|don't|do not|never)\b[^.!?\n]{0,100}\bdeposit\b/i.test(
        ownerText,
      ),
  };
}

export function bookingMailTitle(value: string): boolean {
  return BOOKING.test(value) || LODGING.test(value);
}

function withholdBookingClause(clause: string): boolean {
  return (
    HEALTH.test(clause) ||
    INTIMATE.test(clause) ||
    FINANCES.test(clause) ||
    (bookingMailTitle(clause) && BOOKING_CONTEXT.test(clause))
  );
}

export function bookingDepositFacts(value: string): string[] {
  return bookingClauses(value).filter((clause) => DEPOSIT_FACT.test(clause.trim()));
}

function bookingClauses(value: string): string[] {
  return value.split(/(?<=[.!?])(?=[ \t]+\p{Lu})|(?<=;)[ \t]*|\r?\n/gu);
}

export function bookingReference(value: string): boolean {
  return BOOKING_REFERENCE.test(value);
}

function firstLabel(value: string): string {
  return (value.trim().split(/\r?\n|[;,!?]|\s+[–—-]\s+|[.!]\s+/, 1)[0] ?? '')
    .trim()
    .replace(/\.$/, '');
}

/** Display label from already typed booking metadata, with its narrative tail removed. */
export function bookingSourceLabel(value: string): string {
  const label =
    firstLabel(value)
      .split(
        /\s+(?:and\s+(?:I|we|my|our|they|you|your)\b|because\b|due to\b|follows?\b|precedes?\b)/i,
        1,
      )[0]
      ?.trim() ?? '';
  return withholdBookingClause(label) ? '' : label;
}

export function bookingMailSubject(value: string): string {
  const label = bookingSourceLabel(value);
  const heading = BOOKING_HEADING.exec(label);
  if (!heading) return bookingLogistics(label);
  const name = label.slice(0, heading.index).trim();
  if (withholdBookingClause(name) || !PROPERTY_NAME.test(name)) return heading[0];
  return [name, heading[0]].filter(Boolean).join(' ');
}

export function bookingOccurrenceLabel(value: string): string {
  const label = bookingSourceLabel(value);
  const event = EVENT_LABEL.exec(label);
  if (!event) return label;
  const name = label.slice(0, event.index).trim();
  return [PROPERTY_NAME.test(name) ? name : '', event[0]].filter(Boolean).join(' ');
}

function projectBookingClause(clause: string): string {
  const text = clause.trim().replace(/^[-*]\s+/, '');
  const time = TIME_FIELD.exec(text);
  const timeLabel = time ? text.slice(0, time.index).trim() : '';
  if (time && (!timeLabel || PROPERTY_NAME.test(timeLabel))) {
    const end = time.index + time[0].length;
    const punctuation = text.slice(end) === '.' ? '.' : '';
    return [timeLabel, time[0] + punctuation].filter(Boolean).join(' ');
  }

  for (const [field, value] of BOOKING_FIELDS) {
    const label = field.exec(text)?.[0];
    if (!label) continue;
    const fact = value.exec(text.slice(label.length))?.[0];
    return fact ? label + fact : '';
  }

  const property = /^(?:hotel(?: name)?|property|accommodation|location|city)\s*:\s*/i.exec(
    text,
  )?.[0];
  if (property) {
    const name = firstLabel(text.slice(property.length));
    const fact = PROPERTY_SUFFIX.exec(name)?.[0] ?? (PROPERTY_NAME.test(name) ? name : '');
    return fact ? property + fact : '';
  }

  if (PROPERTY_SUFFIX.exec(text)?.[0] === text.replace(/\.$/, '')) return text;

  const heading = BOOKING_HEADING.exec(text);
  if (!heading || heading.index + heading[0].length !== text.replace(/\.$/, '').length) return '';
  const prefix = text.slice(0, heading.index).trim();
  return !prefix || PROPERTY_NAME.test(prefix) ? text : '';
}

function bookingLogistics(value: string): string {
  return bookingClauses(value)
    .map(projectBookingClause)
    .filter((fact) => fact && !withholdBookingClause(fact))
    .join('\n');
}

export function bookingText(value: string): string {
  const clauses = bookingClauses(value);
  const kept = clauses.map((clause) => {
    const projected = projectBookingClause(clause);
    return projected && !withholdBookingClause(projected)
      ? projected
      : withholdBookingClause(clause)
        ? ''
        : clause;
  });
  return kept.every((clause, index) => clause === clauses[index])
    ? value
    : kept.filter(Boolean).join('\n').trim();
}

export function requiresBookingProjection(toolName: string): boolean {
  return /^gmail\.(?:search|read_thread)$/.test(toolName) || toolName === 'tools.read_result';
}

export function bookingEvidence<T extends { toolName: string; result?: unknown }>(row: T): T {
  return { ...row, result: bookingFields(row.result, requiresBookingProjection(row.toolName)) };
}

function bookingFields(value: unknown, mail = false, field?: string): unknown {
  if (typeof value === 'string') {
    if (field !== undefined && !TEXT_FIELDS.has(field)) return value;
    if (mail) {
      if (field === 'subject') return bookingMailSubject(value);
      if (field === 'fromName') return bookingSourceLabel(value);
      if (field === 'preview' || field === 'chunk') return ''; // Serialized fragments have no field boundaries.
      if (field === 'from' || field === 'to')
        return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(value)?.[0] ?? '';
      if (field === 'text' || field === 'body' || field === 'snippet' || field === 'quote')
        return bookingLogistics(value);
    }
    return bookingText(value);
  }
  if (Array.isArray(value)) return value.map((item) => bookingFields(item, mail, field));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, bookingFields(item, mail, key)]),
  );
}

export function bookingModelWindow(window: ModelMessage[], ownerText: string): ModelMessage[] {
  const current = window.findLastIndex((message) => message.role === 'user');
  return window.slice(Math.max(0, current)).map((message, index) => {
    if (current >= 0 && index === 0) return { role: 'user', content: ownerText };
    if (message.role === 'tool') {
      return {
        ...message,
        content: message.content.map((part) =>
          bookingFields(
            part,
            part.type === 'tool-result' && requiresBookingProjection(part.toolName),
          ),
        ) as typeof message.content,
      };
    }
    if (typeof message.content === 'string')
      return { ...message, content: bookingText(message.content) };
    return { ...message, content: bookingFields(message.content) } as ModelMessage;
  });
}

export function isBookingProjectionSafe(value: unknown): boolean {
  return JSON.stringify(bookingFields(value)) === JSON.stringify(value);
}
