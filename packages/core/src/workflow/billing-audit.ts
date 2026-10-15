import { calendarCivilBoundary } from './calendar-read-window.js';
import { boundedMailSearchPages, compoundTripCompleteSourceThreads } from './compound-trip-read.js';
import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

export interface BillingAuditScope {
  months: number;
  timeZone: string;
  startAt: string;
  endAt: string;
  startDate: string;
  endDateExclusive: string;
  query: string;
}

export interface BillingAuditMessage {
  threadId: string;
  messageId: string;
  subject: string;
  text: string;
  receivedAt?: string;
  sender?: string;
}

export interface BillingAuditRow {
  message: BillingAuditMessage;
  receivedAt: string;
  merchant: string;
  classification: 'charge' | 'trial' | 'refund' | 'cancellation' | 'uncertain';
  amount?: { value: string; currency?: string };
  period?: string;
  recurringEvidence: boolean;
  confidence: 'high' | 'limited';
  quote: string;
}

export interface BillingAuditCoverage {
  complete: boolean;
  issue?: string;
  assessedMessages: number;
  omittedMessages: number;
}

export interface BillingAuditProjection {
  rows: BillingAuditRow[];
  coverage: BillingAuditCoverage;
  mailbox: { searched?: string; configuredOwner?: string; consistent: boolean };
}

const MONTH_WORDS: Record<string, number> = {
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
  eleven: 11,
  twelve: 12,
};

function civilDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const value = year * 12 + month - 1 + delta;
  return { year: Math.floor(value / 12), month: (((value % 12) + 12) % 12) + 1 };
}

function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function dateParts(now: Date, timeZone: string): { year: number; month: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    return year >= 1 && month >= 1 && month <= 12 ? { year, month } : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a count of complete owner-local calendar months to exact instants. */
export function resolveBillingAuditScope(
  months: number,
  now: Date,
  timeZone: string,
): BillingAuditScope | undefined {
  if (!Number.isInteger(months) || months < 1 || months > 12 || !Number.isFinite(now.getTime()))
    return undefined;
  const current = dateParts(now, timeZone);
  if (!current) return undefined;
  const currentMonth = civilDate(current.year, current.month, 1);
  const prior = addMonths(current.year, current.month, -months);
  const startDate = civilDate(prior.year, prior.month, 1);
  const startMs = calendarCivilBoundary(startDate, timeZone);
  const endMs = calendarCivilBoundary(currentMonth, timeZone);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
  const startAt = new Date(startMs).toISOString();
  const endAt = new Date(endMs).toISOString();
  // Gmail's date operators are a coarse mailbox-local index. Widen by two
  // civil days on each side; exact provider received timestamps are filtered
  // against [startAt, endAt) before a message is assessed.
  const broadStart = addDays(startDate, -2).replaceAll('-', '/');
  const broadEnd = addDays(currentMonth, 2).replaceAll('-', '/');
  return {
    months,
    timeZone,
    startAt,
    endAt,
    startDate,
    endDateExclusive: currentMonth,
    query: `after:${broadStart} before:${broadEnd} {receipt invoice charged payment subscription renewal trial refund cancelled cancellation}`,
  };
}

export function isBillingAuditIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return !(
    !/\b(?:audit|review|identify|list|summari[sz]e|analy[sz]e|find)\b/.test(lower) ||
    !/\b(?:subscriptions?|recurring\s+(?:purchase|charge|spend|cost)|billing\s+messages?|billing\s+emails?)\b/.test(
      lower,
    ) ||
    !/\b(?:billing\s+messages?|billing\s+emails?|emails?|gmail|mail|messages?)\b/.test(lower)
  );
}

export function requestedBillingAuditMonths(text: string): number | undefined {
  if (!isBillingAuditIntent(text)) return undefined;
  const range =
    /\b(?:last|past|over)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:complete\s+(?:local\s+)?(?:calendar\s+)?months?)|(?:(?:local\s+)?calendar\s+months?))\b/i.exec(
      text,
    );
  return monthCountFromMatch(range?.[1]);
}

export function requestedBillingAuditMonthCount(text: string): number | undefined {
  if (!isBillingAuditIntent(text)) return undefined;
  const range =
    /\b(?:last|past|over)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:complete\s+)?(?:local\s+)?(?:calendar\s+)?months?\b/i.exec(
      text,
    );
  return monthCountFromMatch(range?.[1]);
}

function monthCountFromMatch(value?: string): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const count =
    Number.isInteger(numeric) && numeric > 0 ? numeric : MONTH_WORDS[value.toLowerCase()];
  if (count === undefined) return undefined;
  return Number.isInteger(count) && count >= 1 && count <= 12 ? count : undefined;
}

function amountFrom(text: string): BillingAuditRow['amount'] {
  const codes = [
    ...text.matchAll(
      /\b(?:(USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|JPY|INR)\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*(USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|JPY|INR))\b/gi,
    ),
  ].flatMap((match) =>
    (match[2] ?? match[3]) && (match[1] ?? match[4])
      ? [
          {
            value: (match[2] ?? match[3]) as string,
            currency: (match[1] ?? (match[4] as string)).toUpperCase(),
          },
        ]
      : [],
  );
  const currencyWords: Array<[RegExp, string]> = [
    [
      /\b(?:US|United States) dollars?\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:US|United States) dollars?\b/i,
      'USD',
    ],
    [
      /\bCanadian dollars?\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*Canadian dollars?\b/i,
      'CAD',
    ],
    [
      /\bAustralian dollars?\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*Australian dollars?\b/i,
      'AUD',
    ],
    [
      /\bNew Zealand dollars?\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*New Zealand dollars?\b/i,
      'NZD',
    ],
    [/\beuros?\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*euros?\b/i, 'EUR'],
    [
      /\bpounds sterling\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*pounds sterling\b/i,
      'GBP',
    ],
    [
      /\bJapanese yen\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*Japanese yen\b/i,
      'JPY',
    ],
  ];
  const wordAmounts = currencyWords.flatMap(([pattern, currency]) => {
    const match = pattern.exec(text);
    const value = match?.[1] ?? match?.[2];
    return value ? [{ value, currency }] : [];
  });
  const unspecifiedWordAmounts = [
    ...text.matchAll(
      /\b(?:dollars?|pounds?)\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:dollars?|pounds?)\b/gi,
    ),
  ].flatMap((match) => {
    const value = match[1] ?? match[2];
    return value ? [{ value }] : [];
  });
  const symbols = [...text.matchAll(/[$€£¥]\s*([0-9][0-9,]*(?:\.\d{1,2})?)/g)].flatMap((match) =>
    match[1] ? [{ value: match[1] }] : [],
  );
  const values = new Set([
    ...codes.map((row) => row.value),
    ...symbols.map((row) => row.value),
    ...wordAmounts.map((row) => row.value),
    ...unspecifiedWordAmounts.map((row) => row.value),
  ]);
  if (values.size !== 1) return undefined;
  const value = [...values][0];
  if (!value) return undefined;
  const explicit = new Set([
    ...codes.filter((row) => row.value === value).map((row) => row.currency),
    ...wordAmounts.filter((row) => row.value === value).map((row) => row.currency),
  ]);
  return { value, ...(explicit.size === 1 ? { currency: [...explicit][0] } : {}) };
}

function periodFrom(text: string): string | undefined {
  const match =
    /\b(?:per\s+month|monthly|each\s+month|every\s+month|billed\s+(?:monthly|every\s+month)|renews?\s+(?:monthly|every\s+month)|per\s+year|annually|annual|each\s+year|every\s+year|billed\s+(?:annually|every\s+year)|renews?\s+(?:annually|every\s+year)|per\s+week|weekly|each\s+week|every\s+week)\b/i.exec(
      text,
    );
  if (!match) return undefined;
  if (/month|monthly/i.test(match[0])) return 'month';
  if (/year|annual|annually/i.test(match[0])) return 'year';
  return 'week';
}

function merchantFrom(message: BillingAuditMessage): string {
  const subject = message.subject.trim().replace(/^(?:fwd?|re):\s*/i, '');
  const fromSubject =
    /^(.{2,80}?)(?:\s+(?:receipt|invoice|payment|charge|subscription|renewal|trial|refund|cancellation)\b|\s*[-:|])/i.exec(
      subject,
    )?.[1];
  const candidate = (fromSubject ?? '').trim();
  return /^(?:your|my|subscription|billing|payment|charge|receipt|invoice|trial|renewal|refund|cancellation|statement|account)$/i.test(
    candidate,
  ) ||
    /^(?:important|priority|high priority|urgent|notification|alert|update|reminder)$/i.test(
      candidate,
    )
    ? ''
    : candidate;
}

function senderFrom(message: BillingAuditMessage): string {
  const sender = message.sender
    ?.trim()
    .replace(/\s*<[^<>]+>.*/, '')
    .trim();
  return sender && sender.length <= 120 ? sender : 'not stated';
}

function classification(text: string): BillingAuditRow['classification'] {
  // Do not turn a notice about a future charge into a historical payment.
  // It remains useful billing evidence, but is not proof that money moved.
  if (
    /\b(?:will|shall|may|might|could)\s+(?:not\s+)?(?:be\s+)?charged\b|\b(?:won['’]t|shan['’]t|can['’]t)\s+(?:be\s+)?charged\b|\b(?:is due to be|is scheduled to be|is expected to be)\s+charged\b/i.test(
      text,
    )
  )
    return 'uncertain';
  if (
    /\b(?:not|never|no)\s+(?:(?:yet|currently|ever)\s+)*(?:(?:been\s+)?(?:charged|paid|processed|refunded|credited)|refund|payment|charge)\b|\b(?:is|are|was|were|has|have|had)\s+not\s+(?:(?:yet|currently|ever)\s+)*(?:been\s+)?(?:charged|paid|processed|refunded|credited)\b|\b(?:wasn['’]t|weren['’]t|isn['’]t|aren['’]t|hasn['’]t|haven['’]t|hadn['’]t|won['’]t|shan['’]t|can['’]t)\s+(?:(?:yet|currently)\s+)?(?:be\s+)?(?:charged|paid|processed|refunded|credited)\b|\b(?:pending|processing|failed|declined|unsuccessful|due|outstanding|requested|awaiting)\b/i.test(
      text,
    )
  )
    return 'uncertain';
  if (
    /\b(?:refund(?: has been)?\s+(?:processed|issued|completed)|refunded|credited back|reversed payment|payment reversal)\b/i.test(
      text,
    )
  )
    return 'refund';
  if (/\b(?:trial (?:started|begins|ends|ending)|free trial|trial period)\b/i.test(text))
    return 'trial';
  if (/\b(?:cancel(?:led|ed|lation)|subscription ended|will not renew)\b/i.test(text))
    return 'cancellation';
  if (
    /\b(?:charged(?: your)?(?: card| account)?\s*(?:for\s*)?|(?:your )?(?:card|account) was charged|(?:payment (?:was )?received|received payment(?: of)?|payment (?:was )?(?:completed|successful)|paid successfully|your payment was successful))\b/i.test(
      text,
    )
  )
    return 'charge';
  return 'uncertain';
}

function evidenceClauses(message: BillingAuditMessage): string[] {
  const body = message.text
    .replace(/\r\n?/g, '\n')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9$€£¥])/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const subject = message.subject.trim();
  if (!body.length) return subject ? [subject] : [];
  // A subject can identify a terse first line (for example, "Acme payment");
  // keep it attached only to that line so facts from separate clauses cannot
  // be combined into a single apparent transaction.
  if (subject && body[0]) body[0] = `${subject}: ${body[0]}`;
  return body;
}

function isBillingEvidenceClause(text: string): boolean {
  if (/\b(?:unsubscribe|email preferences|manage (?:your )?emails?|marketing email)\b/i.test(text))
    return false;
  if (/\bno payment status (?:is )?(?:included|available|provided)\b/i.test(text)) return false;
  return /\b(?:charg(?:e|ed|ing)|payment|paid|receipt|invoice|refund|credit(?:ed)?|trial|subscription|renew(?:al|s)?|billing|cancel(?:led|ed|lation))\b|[$€£¥]\s*\d|\b(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|JPY|INR)\s*\d/i.test(
    text,
  );
}

function conciseQuote(text: string): string {
  const clean = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi, '[link omitted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

export function extractBillingAuditRows(
  messages: ReadonlyArray<BillingAuditMessage>,
  scope: BillingAuditScope,
): {
  rows: BillingAuditRow[];
  outOfRange: number;
  missingReceivedAt: number;
  omitted: number;
  omittedClauses: number;
} {
  const seenMessageIds = new Set<string>();
  const rows: BillingAuditRow[] = [];
  let outOfRange = 0;
  let missingReceivedAt = 0;
  const omitted = Math.max(0, messages.length - 12);
  let omittedClauses = 0;
  for (const message of messages.slice(0, 12)) {
    if (!message.messageId || seenMessageIds.has(message.messageId)) continue;
    seenMessageIds.add(message.messageId);
    const at = message.receivedAt ? Date.parse(message.receivedAt) : NaN;
    if (!Number.isFinite(at)) {
      missingReceivedAt += 1;
      continue;
    }
    if (at < Date.parse(scope.startAt) || at >= Date.parse(scope.endAt)) {
      outOfRange += 1;
      continue;
    }
    const clauses = evidenceClauses(message).filter(isBillingEvidenceClause);
    for (const clause of clauses.slice(0, 3)) {
      const kind = classification(clause);
      const amount = amountFrom(clause);
      const period = periodFrom(clause);
      const recurringEvidence =
        /\b(?:recurring|renews?|renewal|monthly|annually|annual|weekly|every\s+(?:month|year|week)|per\s+(?:month|year|week)|billed\s+(?:monthly|annually|every))\b/i.test(
          clause,
        ) &&
        !/\b(?:unsubscribe|email preferences|manage (?:your )?emails?|marketing email)\b/i.test(
          clause,
        ) &&
        kind === 'charge';
      rows.push({
        message,
        receivedAt: new Date(at).toISOString(),
        merchant: merchantFrom(message) || 'Merchant not stated',
        classification: kind,
        ...(amount ? { amount } : {}),
        ...(period ? { period } : {}),
        recurringEvidence,
        confidence:
          kind !== 'uncertain' && amount?.currency && merchantFrom(message) ? 'high' : 'limited',
        quote: conciseQuote(clause),
      });
    }
    if (clauses.length > 3) {
      // The caller can still report rows, while the omission count forces a
      // partial-coverage label instead of implying every billing statement
      // in a large thread was assessed.
      omittedClauses += clauses.length - 3;
    }
  }
  return { rows, outOfRange, missingReceivedAt, omitted, omittedClauses };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function receivedAt(message: Record<string, unknown>): string | undefined {
  for (const value of [message.receivedAt, message.internalDate]) {
    if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
      const parsed = new Date(Number(value));
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
    if (value === message.receivedAt && typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
  }
  return undefined;
}

/** Build billing facts only from exact-query, current-task complete thread reads. */
export function billingAuditProjection(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): BillingAuditProjection {
  const scope = request.billingAudit;
  if (!scope || !request.mailQuery)
    return {
      rows: [],
      mailbox: { consistent: false },
      coverage: {
        complete: false,
        issue: 'The bounded billing scope could not be established.',
        assessedMessages: 0,
        omittedMessages: 0,
      },
    };
  const searches = evidence.filter((row) => {
    const args = record(row.args);
    return (
      row.fromCurrentTask !== false &&
      row.toolName === 'gmail.search' &&
      args?.query === request.mailQuery &&
      ['success', 'succeeded', 'completed'].includes(row.status) &&
      Boolean(record(row.result))
    );
  });
  const pages = boundedMailSearchPages(request, evidence);
  const last = record(pages.at(-1)?.result);
  const mailboxFields = pages.map((row) => {
    const result = record(row.result);
    return {
      searched:
        typeof result?.mailboxSearched === 'string' ? result.mailboxSearched.trim() : undefined,
      configuredOwner:
        typeof result?.configuredOwnerMailbox === 'string'
          ? result.configuredOwnerMailbox.trim()
          : undefined,
    };
  });
  const normalizedMailboxFields = mailboxFields.map((entry) => ({
    searched: entry.searched?.toLowerCase(),
    configuredOwner: entry.configuredOwner?.toLowerCase(),
  }));
  const mailbox = {
    searched: mailboxFields[0]?.searched,
    configuredOwner: mailboxFields[0]?.configuredOwner,
    consistent:
      mailboxFields.length > 0 &&
      Boolean(mailboxFields[0]?.searched) &&
      normalizedMailboxFields.every(
        (entry) =>
          entry.searched === normalizedMailboxFields[0]?.searched &&
          entry.configuredOwner === normalizedMailboxFields[0]?.configuredOwner,
      ),
  };
  const rawHits = pages.flatMap((row) => {
    const results = record(row.result)?.results;
    return Array.isArray(results) ? results : [];
  });
  const hitsHaveThreadIds = rawHits.every((hit) => {
    const id = record(hit)?.threadId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id);
  });
  const paginationComplete =
    pages.length > 0 &&
    pages.length === searches.length &&
    pages.length <= 3 &&
    last?.complete === true &&
    last.hasMore === false &&
    hitsHaveThreadIds &&
    pages.every((row, index) => {
      const result = record(row.result);
      const receipt = record(result?.receipt);
      const losses = Array.isArray(receipt?.losses) ? receipt.losses : [];
      const unavailable = Array.isArray(result?.unavailable) ? result.unavailable : [];
      const isLast = index === pages.length - 1;
      return (
        Array.isArray(result?.results) &&
        unavailable.length === 0 &&
        (isLast
          ? result?.complete === true && result?.hasMore === false && losses.length === 0
          : result?.complete === false &&
            result?.hasMore === true &&
            losses.length === 1 &&
            losses[0] === 'provider-page')
      );
    });
  const queryComplete = paginationComplete && mailbox.consistent;
  const expectedIds = [
    ...new Set(
      pages.flatMap((row) => {
        const results = record(row.result)?.results;
        return Array.isArray(results)
          ? results.flatMap((item) => {
              const id = record(item)?.threadId;
              return typeof id === 'string' && id ? [id] : [];
            })
          : [];
      }),
    ),
  ];
  const completeThreads = compoundTripCompleteSourceThreads(request, evidence);
  const completeIds = new Set(
    completeThreads.flatMap((row) => {
      const id = record(row.args)?.threadId;
      return typeof id === 'string' ? [id] : [];
    }),
  );
  const missingThreads = expectedIds.filter((id) => !completeIds.has(id));
  const fragments = new Map<
    string,
    {
      threadId: string;
      messageId: string;
      order: number;
      subject: string;
      sender: string;
      pages: Array<{ offset: number; text: string; receivedAt?: string }>;
    }
  >();
  for (const row of completeThreads) {
    const threadId = record(row.args)?.threadId;
    const rawMessages = record(row.result)?.messages;
    if (typeof threadId !== 'string' || !Array.isArray(rawMessages)) continue;
    const start = Number.isInteger(record(row.args)?.startMessageIndex)
      ? Number(record(row.args)?.startMessageIndex)
      : 0;
    const firstOffset = Number.isInteger(record(row.args)?.startMessageOffset)
      ? Number(record(row.args)?.startMessageOffset)
      : 0;
    for (const [index, raw] of rawMessages.entries()) {
      const message = record(raw);
      if (!message || typeof message.messageId !== 'string' || typeof message.text !== 'string')
        continue;
      const key = `${threadId}:${message.messageId}`;
      const current = fragments.get(key) ?? {
        threadId,
        messageId: message.messageId,
        order: start,
        subject: typeof message.subject === 'string' ? message.subject.slice(0, 240) : '',
        sender: typeof message.from === 'string' ? message.from.slice(0, 160) : '',
        pages: [],
      };
      const received = receivedAt(message);
      current.order = Math.min(current.order, start + index);
      if (!current.subject && typeof message.subject === 'string')
        current.subject = message.subject.slice(0, 240);
      if (!current.sender && typeof message.from === 'string')
        current.sender = message.from.slice(0, 160);
      current.pages.push({
        offset: index === 0 ? firstOffset : 0,
        text: message.text,
        ...(received ? { receivedAt: received } : {}),
      });
      fragments.set(key, current);
    }
  }
  const sourceMessages: BillingAuditMessage[] = [...fragments.values()]
    .sort((left, right) => left.order - right.order)
    .map((message) => {
      const pages = message.pages.toSorted((left, right) => left.offset - right.offset);
      const timestamps = new Set(
        pages.flatMap((part) => (part.receivedAt ? [part.receivedAt] : [])),
      );
      const received =
        pages.length > 0 && pages.every((part) => part.receivedAt) && timestamps.size === 1
          ? pages[0]?.receivedAt
          : undefined;
      return {
        threadId: message.threadId,
        messageId: message.messageId,
        subject: message.subject,
        sender: message.sender,
        text: pages.map((part) => part.text).join(''),
        ...(received ? { receivedAt: received } : {}),
      };
    });
  const extracted = extractBillingAuditRows(sourceMessages, scope);
  const missingDate = extracted.missingReceivedAt > 0;
  const omissions: string[] = [];
  if (!paginationComplete)
    omissions.push('Gmail search pagination did not prove complete coverage of the bounded query.');
  if (!mailbox.consistent)
    omissions.push(
      'The connected mailbox could not be identified consistently across the search receipts.',
    );
  if (!hitsHaveThreadIds)
    omissions.push(
      'Some search hits lacked a valid Gmail thread identity and could not be assessed.',
    );
  if (expectedIds.length > 6)
    omissions.push(
      `${expectedIds.length - 6} matching threads exceeded the six-thread assessment cap.`,
    );
  if (missingThreads.length)
    omissions.push(
      `${missingThreads.length} matching thread${missingThreads.length === 1 ? ' was' : 's were'} not fully read.`,
    );
  if (missingDate)
    omissions.push(
      `${extracted.missingReceivedAt} message${extracted.missingReceivedAt === 1 ? ' lacks' : 's lack'} a verifiable received timestamp and could not be placed in the local-month window.`,
    );
  if (extracted.omitted)
    omissions.push(`${extracted.omitted} messages exceeded the 12-message assessment cap.`);
  if (extracted.omittedClauses)
    omissions.push(
      `${extracted.omittedClauses} additional billing statements in assessed messages exceeded the three-clause-per-message detail cap.`,
    );
  if (request.billingAuditCompanionGap) omissions.push(request.billingAuditCompanionGap);
  return {
    rows: extracted.rows,
    mailbox,
    coverage: {
      complete:
        queryComplete &&
        !request.billingAuditCompanionGap &&
        expectedIds.length <= 6 &&
        missingThreads.length === 0 &&
        !missingDate &&
        extracted.omitted === 0 &&
        extracted.omittedClauses === 0,
      ...(omissions.length ? { issue: omissions.join(' ') } : {}),
      assessedMessages: new Set(extracted.rows.map((row) => row.message.messageId)).size,
      omittedMessages: missingThreads.length + extracted.missingReceivedAt + extracted.omitted,
    },
  };
}

export function renderBillingAudit(input: {
  scope: BillingAuditScope;
  rows: ReadonlyArray<BillingAuditRow>;
  coverage: BillingAuditCoverage;
  mailbox?: BillingAuditProjection['mailbox'];
}): string {
  const { scope, rows, coverage, mailbox } = input;
  const visibleRows = rows.slice(0, 12);
  const formatAmount = (amount?: BillingAuditRow['amount']) =>
    amount ? `${amount.value} ${amount.currency ?? '(currency unstated)'}` : 'not stated';
  const lines = [
    `Billing email review · ${scope.months} complete local months (${scope.startDate} to ${scope.endDateExclusive}, ${scope.timeZone})`,
  ];
  if (mailbox) {
    lines.push(
      mailbox.consistent && mailbox.searched
        ? `Mailbox searched: ${escapeCell(mailbox.searched)}; configured owner mailbox: ${escapeCell(mailbox.configuredOwner ?? 'not supplied')}. This covers the connected mailbox shown, not every mailbox the owner may use.`
        : 'Mailbox scope could not be verified consistently from the Gmail search receipts.',
    );
  }
  if (!coverage.complete) {
    lines.push(
      `Coverage: partial. ${coverage.issue ?? 'Some matching mail was not fully assessed.'}`,
    );
  } else {
    lines.push(`Coverage: complete for matching, fully read Gmail threads in this bounded query.`);
  }
  if (!rows.length) {
    lines.push(
      'No in-range billing messages with a verifiable received date and complete thread were found.',
    );
  } else {
    lines.push(
      '',
      `Evidence clauses: ${visibleRows.length} shown of ${rows.length} assessed.`,
      '| Mail-stated merchant | Sender | Received | Evidence | Amount / cadence | Source |',
      '|---|---|---|---|---|---|',
    );
    for (const row of visibleRows) {
      const amount = formatAmount(row.amount);
      const cadence = row.period ?? (row.recurringEvidence ? 'cadence unclear' : undefined);
      const url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(row.message.threadId)}`;
      const label = conciseQuote(row.message.subject) || 'Message';
      lines.push(
        `| ${escapeCell(row.merchant)} | ${escapeCell(senderFrom(row.message))} | ${row.receivedAt.slice(0, 10)} | mail-reported ${row.classification}: “${escapeCell(row.quote)}” | ${amount}${cadence ? ` / ${cadence}` : ''} | [${escapeCell(label)}](${url}) |`,
      );
    }
    const displayedIds = new Set(visibleRows.map((row) => row.message.messageId));
    const omittedSources = new Map<string, BillingAuditMessage>();
    for (const row of rows) {
      if (!displayedIds.has(row.message.messageId))
        omittedSources.set(row.message.messageId, row.message);
    }
    if (omittedSources.size) {
      const links = [...omittedSources.values()].map((message) => {
        const url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}`;
        const label = conciseQuote(message.subject) || 'Message';
        return `[${escapeCell(label)}](<${url}>)`;
      });
      lines.push(
        '',
        `Additional assessed clauses not shown (${rows.length - visibleRows.length}); source threads: ${links.join(', ')}.`,
      );
    }
  }
  const recurring = rows.filter(
    (row) =>
      row.classification === 'charge' &&
      row.recurringEvidence &&
      row.amount?.currency &&
      row.period,
  );
  if (recurring.length) {
    lines.push(
      '',
      `Supported recurring amounts (${recurring.length} mail-reported entries; currencies and periods kept separate):`,
    );
    for (const row of recurring.slice(0, 8)) {
      if (!row.amount || !row.period) continue;
      lines.push(
        `- ${row.merchant}: ${row.amount.value} ${row.amount.currency} per ${row.period}.`,
      );
    }
    if (recurring.length > 8)
      lines.push(`- ${recurring.length - 8} additional assessed entries are not expanded here.`);
  } else {
    lines.push(
      '',
      'No recurring-cost estimate is supported by the assessed messages. A receipt, trial, or cancellation notice alone does not establish recurring spend.',
    );
  }
  lines.push(
    'These are mail-reported billing details, not bank-confirmed transactions or proof of current account status.',
    'Currencies and billing periods remain separate; no FX conversion or cross-period total was calculated.',
  );
  if (rows.length) {
    lines.push('', 'Review decisions (chat only):');
    const first = rows[0];
    if (!first) return lines.join('\n');
    lines.push(
      `- Decide whether to verify ${first.merchant}’s current plan and billing status directly with the provider; this mail review does not establish the current account state.`,
    );
    const charge = rows.find((row) => row.classification === 'charge' && row.amount);
    const other = rows.find((row) => row !== first);
    if (charge?.amount)
      lines.push(
        `- Decide whether to reconcile the stated ${formatAmount(charge.amount)} charge from ${charge.merchant} against your own records.`,
      );
    else if (other)
      lines.push(
        `- Decide whether to verify the ${other.classification} message from ${other.merchant} with the provider.`,
      );
    else
      lines.push(
        `- Decide whether the evidence from ${first.merchant} is sufficient for your review or whether you want to check the provider directly.`,
      );
  }
  return lines.join('\n');
}

function escapeCell(value: string): string {
  return value
    .replace(/[|\n\r]/g, ' ')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replaceAll('<', '')
    .replaceAll('>', '')
    .replaceAll('*', '')
    .replaceAll('_', '')
    .replaceAll('`', '')
    .replace(/\s+/g, ' ')
    .trim();
}
