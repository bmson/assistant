import type { ModelMessage } from 'ai';

// Scope this projection to owner-authored booking lookups. It does not grant a
// tool permission, and source text cannot opt the current turn into disclosure.
const BOOKING =
  /\b(?:bookings?|reservations?|check[- ]?in|check[- ]?out|itinerary|boarding pass)\b/i;
const OWNER_BOOKING =
  /\b(?:my|our)\b[^.!?\n]{0,100}\b(?:bookings?|reservations?|hotel|lodging|accommodation|check[- ]?in|check[- ]?out|itinerary|inbox|email)\b/i;
const NAMED_MAIL_READ =
  /\b(?:read|open|find|check|search|look up)\b[^.!?\n]{0,100}\b(?:confirmation|booking|reservation)\s+(?:e-?mail|message|thread)\b/i;
// Require a booking field, a date/time tied to a booking event, or a booking
// heading. A property name or a travel noun alone is not evidence of logistics.
const LOGISTICS_FIELD =
  /^(?:[-*]\s+)?(?:hotel(?: name)?|property|accommodation|(?:hotel |property )?address|room type|(?:booking|reservation|confirmation) (?:reference|number|code|id)|flight(?: number)?|gate|terminal)\s*:\s*\S/i;
const LOGISTICS_TIME =
  /\b(?:check[- ]?(?:in|out)|departure|arrival|departs?|arrives?)\s*(?:(?:is|starts|opens|closes)\s+)?(?:(?:at|on|from|by|until|after)\s+|[:–—-]\s*)?(?:\d|noon\b|midnight\b|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d)/i;
const BOOKING_HEADING =
  /^(?:[\p{L}\p{N}'’&(), -]{1,100}\s+)?(?:(?:booking|reservation) (?:confirmation|confirmed|cancelled|canceled|rescheduled)|itinerary)(?:\s*[:#]\s*[\w-]+)?[.!]?$/iu;
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

export function bookingText(value: string): string {
  const clauses = bookingClauses(value);
  const kept = clauses.filter((clause) => !withholdBookingClause(clause));
  return kept.length === clauses.length ? value : kept.join('\n').trim();
}

function gmailEvidence(toolName: string): boolean {
  return /^gmail\.(?:search|read_thread)$/.test(toolName);
}

export function bookingEvidence<T extends { toolName: string; result?: unknown }>(row: T): T {
  return { ...row, result: bookingFields(row.result, gmailEvidence(row.toolName)) };
}

function bookingFields(value: unknown, mail = false, field?: string): unknown {
  if (typeof value === 'string') {
    if (field !== undefined && !TEXT_FIELDS.has(field)) return value;
    if (mail && (field === 'text' || field === 'body' || field === 'snippet')) {
      // Mail can contain unlabelled notes and continuations. Project booking
      // lines only, even when a line has no recognized sensitive vocabulary.
      return bookingClauses(value)
        .map((clause) => clause.trim())
        .filter(
          (clause) =>
            !withholdBookingClause(clause) &&
            (LOGISTICS_FIELD.test(clause) ||
              LOGISTICS_TIME.test(clause) ||
              BOOKING_HEADING.test(clause)),
        )
        .join('\n');
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
          bookingFields(part, part.type === 'tool-result' && gmailEvidence(part.toolName)),
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
