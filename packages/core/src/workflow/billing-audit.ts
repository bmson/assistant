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
  amount?: { value: string; currency: string };
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
    !/\b(?:subscription|recurring\s+(?:purchase|charge|spend|cost)|billing\s+messages?|billing\s+emails?)\b/.test(
      lower,
    ) ||
    !/\b(?:billing\s+messages?|billing\s+emails?|emails?|gmail|mail|messages?)\b/.test(lower)
  );
}

export function requestedBillingAuditMonths(text: string): number | undefined {
  if (!isBillingAuditIntent(text)) return undefined;
  const range =
    /\b(?:last|past|over)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:complete\s+)?(?:local\s+calendar\s+months?|calendar\s+months?|months?)\b/i.exec(
      text,
    );
  if (!range) return undefined;
  const numeric = Number(range[1]);
  const count =
    Number.isInteger(numeric) && numeric > 0 ? numeric : MONTH_WORDS[range[1]?.toLowerCase() ?? ''];
  if (count === undefined) return undefined;
  return Number.isInteger(count) && count >= 1 && count <= 12 ? count : undefined;
}

function amountFrom(text: string): BillingAuditRow['amount'] {
  const codes = [
    ...text.matchAll(
      /\b(USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|JPY|INR)\s*([0-9][0-9,]*(?:\.\d{1,2})?)\b/gi,
    ),
  ];
  const symbols = [...text.matchAll(/([$€£¥])\s*([0-9][0-9,]*(?:\.\d{1,2})?)/g)];
  const candidates = [
    ...codes.flatMap((match) => {
      const currency = match[1];
      const value = match[2];
      return currency && value ? [{ currency: currency.toUpperCase(), value }] : [];
    }),
    ...symbols.flatMap((match) => {
      const symbol = match[1];
      const value = match[2];
      const currency = symbol
        ? ({ $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' } as Record<string, string>)[symbol]
        : undefined;
      return currency && value ? [{ currency, value }] : [];
    }),
  ];
  const unique = new Map(
    candidates.map((candidate) => [`${candidate.currency}:${candidate.value}`, candidate]),
  );
  return unique.size === 1 ? [...unique.values()][0] : undefined;
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
  const sender = message.sender
    ?.trim()
    .replace(/\s*<[^<>]+>.*/, '')
    .trim();
  if (sender && sender.length <= 120) return sender;
  const subject = message.subject.trim();
  const fromSubject =
    /^(.{2,80}?)(?:\s+(?:receipt|invoice|payment|charge|subscription|renewal|trial|refund|cancellation)\b|\s*[-:|])/i.exec(
      subject,
    )?.[1];
  return (fromSubject ?? '').trim();
}

function classification(text: string): BillingAuditRow['classification'] {
  // Do not turn a notice about a future charge into a historical payment.
  // It remains useful billing evidence, but is not proof that money moved.
  if (
    /\b(?:will|shall|may|might|could)\s+(?:be\s+)?charged\b|\b(?:is due to be|is scheduled to be|is expected to be)\s+charged\b/i.test(
      text,
    )
  )
    return 'uncertain';
  if (/\b(?:refund(?:ed)?|credited back|reversal|reversed payment|chargeback)\b/i.test(text))
    return 'refund';
  if (/\b(?:trial (?:started|begins|ends|ending)|free trial|trial period)\b/i.test(text))
    return 'trial';
  if (/\b(?:cancel(?:led|ed|lation)|subscription ended|will not renew)\b/i.test(text))
    return 'cancellation';
  if (
    /\b(?:charged(?: your)?(?: card| account)?\s*(?:for\s*)?|(?:your )?(?:card|account) was charged|payment (?:was )?received|payment of|charge of|paid successfully|your payment was successful)\b/i.test(
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
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 420 ? `${clean.slice(0, 420)}…` : clean;
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
        confidence: kind !== 'uncertain' && amount && merchantFrom(message) ? 'high' : 'limited',
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
  const rawHits = pages.flatMap((row) => {
    const results = record(row.result)?.results;
    return Array.isArray(results) ? results : [];
  });
  const hitsHaveThreadIds = rawHits.every((hit) => {
    const id = record(hit)?.threadId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id);
  });
  const queryComplete =
    pages.length > 0 &&
    pages.length === searches.length &&
    pages.length <= 3 &&
    last?.complete === true &&
    last.hasMore === false &&
    hitsHaveThreadIds &&
    pages.every((row) => {
      const result = record(row.result);
      return Array.isArray(result?.results) && result?.complete !== false;
    });
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
  const sourceMessages: BillingAuditMessage[] = [];
  for (const row of completeThreads) {
    const threadId = record(row.args)?.threadId;
    const rawMessages = record(row.result)?.messages;
    if (typeof threadId !== 'string' || !Array.isArray(rawMessages)) continue;
    for (const raw of rawMessages) {
      const message = record(raw);
      if (!message || typeof message.messageId !== 'string' || typeof message.text !== 'string')
        continue;
      sourceMessages.push({
        threadId,
        messageId: message.messageId,
        subject: typeof message.subject === 'string' ? message.subject.slice(0, 240) : '',
        text: message.text,
        ...(receivedAt(message) ? { receivedAt: receivedAt(message) } : {}),
        ...(typeof message.from === 'string' ? { sender: message.from.slice(0, 160) } : {}),
      });
    }
  }
  const extracted = extractBillingAuditRows(sourceMessages, scope);
  const missingDate = extracted.missingReceivedAt > 0;
  const omissions: string[] = [];
  if (!queryComplete)
    omissions.push('Gmail search pagination did not prove complete coverage of the bounded query.');
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
  return {
    rows: extracted.rows,
    coverage: {
      complete:
        queryComplete &&
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
}): string {
  const { scope, rows, coverage } = input;
  const lines = [
    `Billing email review · ${scope.months} complete local months (${scope.startDate} to ${scope.endDateExclusive}, ${scope.timeZone})`,
  ];
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
      '| Merchant | Received | Evidence | Amount | Period | Confidence | Source |',
      '|---|---|---|---:|---|---|---|',
    );
    for (const row of rows) {
      const amount = row.amount ? `${row.amount.value} ${row.amount.currency}` : 'not stated';
      const period =
        row.period ??
        (row.recurringEvidence ? 'subscription stated; interval unclear' : 'not stated');
      const url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(row.message.threadId)}`;
      const label =
        row.message.subject
          .replaceAll('[', '')
          .replaceAll(']', '')
          .replaceAll('<', '')
          .replaceAll('>', '')
          .slice(0, 80) || 'Message';
      lines.push(
        `| ${escapeCell(row.merchant)} | ${row.receivedAt.slice(0, 10)} | mail-reported ${row.classification}${row.recurringEvidence ? '; recurring language present' : ''} — “${escapeCell(row.quote)}” | ${amount} | ${period} | ${row.confidence} | [${escapeCell(label)}](${url}) |`,
      );
    }
  }
  const recurring = rows.filter(
    (row) => row.classification === 'charge' && row.recurringEvidence && row.amount && row.period,
  );
  if (recurring.length) {
    lines.push('', 'Supported recurring amounts (kept separate by currency and period):');
    for (const row of recurring) {
      if (!row.amount || !row.period) continue;
      lines.push(
        `- ${row.merchant}: ${row.amount.value} ${row.amount.currency} per ${row.period}.`,
      );
    }
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
        `- Decide whether to reconcile the stated ${charge.amount.value} ${charge.amount.currency} charge from ${charge.merchant} against your own records.`,
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
