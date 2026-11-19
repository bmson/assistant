import {
  admittedBillEmailEvidence,
  type BillEmailEvidence,
  type EmailBillStatus,
} from './bill-email-evidence.js';
import type { CalendarRecoveryObservation } from './calendar-recovery.js';
import { ownerLocalDay } from './nudge-policy.js';
import { type PracticeChangeMailFact, practiceChangeFromMail } from './practice-change-mail.js';
import type { Records } from './records.js';
import type { SituationPackView } from './situations-schema.js';

/** A rescheduled deadline is a new observation, unlike a retry of the same deadline. */
export function commitmentDueMomentKey(id: string, dueAt: Date): string {
  if (!Number.isFinite(dueAt.getTime())) throw new Error('Invalid commitment due occurrence');
  return `commitment-due:${id}:${dueAt.toISOString()}`;
}

/** One stored calendar event: what the previous read saw, to diff the next read against. */
export interface PulseCalendarSnapshot {
  calendarId: string;
  eventId: string;
  iCalUID: string | null;
  summary: string;
  start: string;
  end: string;
  status: string | null;
  attendeeResponseHash: unknown;
}

export interface PulseMail {
  channelMessageId: string;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
  obligationVersion?: number;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  /** The scorer's category, which decides what the follow-up offers to do. */
  category: string;
  importance: number;
  obligationStatus?: string;
  practiceChange?: PracticeChangeMailFact;
  billInvoice?: Extract<BillEmailEvidence, { kind: 'invoice' }>;
  securityIncidentId?: string | null;
  securityRevision?: number | null;
  securityDisposition?: string | null;
  securityDecisionRevision?: number | null;
}

export interface PulseBillMailQuery {
  now: Date;
  ingestedBy: Date;
  dueThrough: string;
  minImportance: number;
  limit: number;
}

export const PULSE_BILL_DISCOVERY_LIMIT = 500;

/** Invoice due dates are civil dates, so the lead does not depend on DST or the worker's zone. */
export function pulseBillDueThrough(timeZone: string, now: Date): string {
  const day = new Date(`${ownerLocalDay(timeZone, now)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 3);
  return day.toISOString().slice(0, 10);
}

export function pulseBillMailCandidate(
  row: Records['emailIngest'],
  input: PulseBillMailQuery,
):
  | (PulseMail & { providerThreadId: string; billInvoice: NonNullable<PulseMail['billInvoice']> })
  | null {
  const invoice = admittedBillEmailEvidence(row);
  if (
    invoice?.kind !== 'invoice' ||
    invoice.dueDate > input.dueThrough ||
    !row.actionable ||
    !Number.isFinite(row.importance) ||
    row.importance < input.minImportance ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    row.createdAt > input.ingestedBy ||
    !row.providerReceivedAt ||
    !Number.isFinite(row.providerReceivedAt.getTime()) ||
    row.providerReceivedAt > input.now ||
    !row.providerMessageId ||
    !row.providerThreadId ||
    row.securityIncidentId ||
    row.obligationDecision ||
    !['unknown', 'open'].includes(row.obligationStatus ?? 'unknown') ||
    practiceChangeFromMail(row)
  )
    return null;
  return {
    channelMessageId: row.channelMessageId,
    providerThreadId: row.providerThreadId,
    providerMessageId: row.providerMessageId,
    obligationVersion: row.obligationVersion ?? 0,
    fromEmail: row.fromEmail,
    fromName: row.fromName ?? null,
    subject: row.subject,
    category: row.category,
    importance: row.importance,
    obligationStatus: row.obligationStatus ?? 'unknown',
    billInvoice: invoice,
  };
}

/** A bounded metadata read of the owner's current Gmail thread; no body or model output. */
export type EmailThreadHeadReader = (input: {
  threadId: string;
  signal: AbortSignal;
}) => Promise<{ threadId: string; latestMessageId: string; latestReceivedAt: Date } | null>;

export interface PulseEmailSourceFence {
  channelMessageId: string;
  threadId: string;
  providerMessageId: string;
  obligationVersion: number;
  practiceChange?: PracticeChangeMailFact;
  billInvoice?: Extract<BillEmailEvidence, { kind: 'invoice' }>;
}

export interface PulseCommitment {
  id: string;
  title: string;
  nextAction: string;
  dueAt: Date;
}

/** Source observation and its inert proposal; no external effect is authorized here. */
export interface PulseNoticeInput {
  agentId: string;
  taskId?: string;
  now: Date;
  /** Opaque erasure generation captured BEFORE reading candidate source data. */
  observationFence: string | null;
  pacing: { gapSince: Date; windowSince: Date; dailyCap: number };
  moment: { kind: string; key: string; summary: string };
  notice: { text: string; extraParts: readonly unknown[] };
  suggestion?: {
    summary: string;
    proposedAction: string;
    sourceRef: string;
    origin: string;
    expiresAt: Date;
  };
  /** Optional incident fence; admission shares it with mail arrival/briefing. */
  securityIncident?: { id: string; revision: number };
  /** Recheck the current ingested source and owner decision inside admission. */
  emailSource?: PulseEmailSourceFence;
}

export type PulseNoticeOutcome =
  | {
      status: 'persisted';
      momentId: string;
      messageId: string;
      conversationId: string;
      suggestionCreated: boolean;
    }
  | { status: 'already-said' | 'min-gap' | 'daily-cap' | 'stale-source' };

/** Shared bounds and preference semantics for both transactional adapters. */
export function pulseDailyCap(maximum: number, owner: number | null): number {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 6)
    throw new Error('Pulse daily cap must be an integer from zero to six');
  // Existing Firestore installations can use zero to suppress ambient notices;
  // PostgreSQL's settings constraint starts at one. Preserve the stricter value.
  if (owner !== null && (!Number.isSafeInteger(owner) || owner < 0))
    throw new Error('Invalid owner ambient daily cap');
  return owner === null ? maximum : Math.min(maximum, owner);
}

export function validatePulseNotice(input: PulseNoticeInput): void {
  if (input.emailSource) {
    const source = input.emailSource;
    if (
      [source.channelMessageId, source.threadId, source.providerMessageId].some(
        (value) => typeof value !== 'string' || !value || value.length > 256,
      ) ||
      !Number.isSafeInteger(source.obligationVersion) ||
      source.obligationVersion < 0
    )
      throw new Error('Invalid pulse email source fence');
    const expectedKey = input.securityIncident
      ? `security-incident:${input.securityIncident.id}:r${input.securityIncident.revision}`
      : source.billInvoice
        ? `bill-due:${source.billInvoice.identity}`
        : `mail-action:${source.channelMessageId}`;
    if (
      input.moment.kind !==
        (source.practiceChange
          ? 'practice-change'
          : source.billInvoice
            ? 'bill-due'
            : 'mail-action') ||
      input.moment.key !== expectedKey
    )
      throw new Error('Pulse email source does not match the moment');
  }
  const dates = [input.now, input.pacing.gapSince, input.pacing.windowSince];
  if (dates.some((date) => !(date instanceof Date) || !Number.isFinite(date.getTime())))
    throw new Error('Pulse admission requires valid timestamps');
  if (input.pacing.windowSince > input.pacing.gapSince || input.pacing.gapSince > input.now)
    throw new Error('Invalid pulse pacing window');
  pulseDailyCap(input.pacing.dailyCap, null);
  for (const [label, text, maximum] of [
    ['owner', input.agentId, 1000],
    ['kind', input.moment.kind, 100],
    ['key', input.moment.key, 1000],
    ['summary', input.moment.summary, 400],
    ['notice', input.notice.text, 10_000],
  ] as const) {
    if (typeof text !== 'string' || !text || text.length > maximum)
      throw new Error(`Invalid pulse ${label}`);
  }
  if (
    !Array.isArray(input.notice.extraParts) ||
    JSON.stringify(input.notice.extraParts).length > 65_536
  )
    throw new Error('Pulse notice parts exceeded bounds');
  if (input.suggestion) {
    const suggestion = input.suggestion;
    if (
      !suggestion.summary ||
      suggestion.summary.length > 500 ||
      !suggestion.proposedAction ||
      suggestion.proposedAction.length > 2000 ||
      !suggestion.sourceRef ||
      suggestion.sourceRef.length > 1000 ||
      !suggestion.origin ||
      suggestion.origin.length > 100 ||
      !(suggestion.expiresAt instanceof Date) ||
      !Number.isFinite(suggestion.expiresAt.getTime()) ||
      suggestion.expiresAt <= input.now
    )
      throw new Error('Invalid pulse proposal');
  }
  if (
    input.securityIncident &&
    (!input.securityIncident.id ||
      input.securityIncident.id.length > 100 ||
      !Number.isSafeInteger(input.securityIncident.revision) ||
      input.securityIncident.revision < 1)
  )
    throw new Error('Invalid pulse security incident fence');
}

/** The `pulse.check` job's ledger and reads. Choosing and phrasing a moment stay in core. */
export interface PulseRepository {
  readonly kind: 'pulse-repository';
  /** Moments delivered at or after `since`, for pacing. */
  deliveredSince(agentId: string, since: Date): Promise<number>;
  /** The owner's own ambient daily cap, or null when they set none. */
  ambientDailyCap(agentId: string): Promise<number | null>;
  /** Keys of every moment of this kind already delivered. */
  momentKeys(agentId: string, kind: string): Promise<string[]>;
  recordCalendarRecovery?(
    agentId: string,
    fence: string | null,
    at: Date,
    complete: boolean,
    observations: readonly CalendarRecoveryObservation[],
  ): Promise<void>;
  calendarSnapshot(agentId: string): Promise<PulseCalendarSnapshot[]>;
  /**
   * Bring the stored snapshot up to date with one successful read: drop the
   * cancelled events, upsert the events seen, and forget rows not seen since
   * `staleBefore`.
   */
  syncCalendarSnapshot(
    agentId: string,
    input: {
      cancelled: Array<{ calendarId: string; eventId: string }>;
      seen: PulseCalendarSnapshot[];
      staleBefore: Date;
      now: Date;
    },
  ): Promise<void>;
  /**
   * Actionable mail at or above `minImportance` ingested inside
   * `[since, until]` or an authenticated practice change received by now, not already admitted to the moment ledger, ordered by importance, age and identity.
   */
  actionableMail(
    agentId: string,
    input: { since: Date; until: Date; now: Date; minImportance: number; limit: number },
  ): Promise<PulseMail[]>;
  /** Independently discover actionable invoices by their verified civil deadline. */
  dueBillMail?(agentId: string, input: PulseBillMailQuery): Promise<PulseMail[]>;
  /** Derive current bill state from exact, durably admitted issuer evidence. */
  billStatus?(
    agentId: string,
    invoice: Extract<BillEmailEvidence, { kind: 'invoice' }>,
    now: Date,
  ): Promise<EmailBillStatus>;
  /** Active obligations due inside `[now, until]`, excluding admitted deadline occurrences, earliest deadline then identity. */
  dueCommitments(
    agentId: string,
    input: { now: Date; until: Date; limit: number },
  ): Promise<PulseCommitment[]>;
  observationFence(agentId: string): Promise<string | null>;
  /**
   * Serialize owner admission, recheck current preferences and pacing, and
   * atomically persist moment + owner message + new proposal. A throw leaves
   * ALL of those absent. Duplicate legacy moments are never reconstructed.
   * No network work occurs inside this transaction; phone delivery is separate.
   */
  admitNotice(input: PulseNoticeInput): Promise<PulseNoticeOutcome>;
  markPinged(agentId: string, momentId: string, pinged: boolean): Promise<void>;
  /** The owner's unarchived situation packs, with their source changes. */
  situationPacks(agentId: string): Promise<SituationPackView[]>;
}
