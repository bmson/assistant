import type { SituationPackView } from './situations-schema.js';

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
  fromEmail: string;
  fromName: string | null;
  subject: string;
  /** The scorer's category, which decides what the follow-up offers to do. */
  category: string;
  importance: number;
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
}

export type PulseNoticeOutcome =
  | {
      status: 'persisted';
      momentId: string;
      messageId: string;
      conversationId: string;
      suggestionCreated: boolean;
    }
  | { status: 'already-said' | 'min-gap' | 'daily-cap' };

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
   * `[since, until]` that no finished task has picked up, most important first.
   */
  actionableMail(
    agentId: string,
    input: { since: Date; until: Date; minImportance: number; limit: number },
  ): Promise<PulseMail[]>;
  /** Open commitments due inside `[now, until]` that are not snoozed past `now`. */
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
