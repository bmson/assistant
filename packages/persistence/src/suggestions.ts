import type { Records } from './records.js';

export type SuggestionRecord = Records['suggestions'];

export interface BookingCancellationBinding {
  /** Exact provider event selected from the owner's primary calendar. */
  calendarEventId: string;
  /** Exact booking marker copied from authenticated source evidence. */
  bookingIdentity: string;
}

export interface CreateSuggestionRecord {
  agentId: string;
  conversationId?: string;
  summary: string;
  proposedAction: string;
  /** Stable per proposal, so a producer that re-runs proposes nothing twice. */
  sourceRef: string;
  origin: string;
  expiresAt: Date;
  bookingKey?: string;
  bookingVersion?: number;
  bookingCancellation?: BookingCancellationBinding;
  /**
   * `dismissed` records a ledger-only row that never surfaces as a card, for a
   * producer that only needs the `(agentId, sourceRef)` fence. Pending otherwise.
   */
  status?: 'pending' | 'dismissed';
}

/** Proposals a producer offers the owner as one-tap suggestions. */
export interface SuggestionRepository {
  readonly kind: 'suggestion-repository';
  /**
   * Record a proposal unless one with the same `(agentId, sourceRef)` exists,
   * whatever its status. Returns the new row, or null when it already existed.
   */
  create(input: CreateSuggestionRecord): Promise<SuggestionRecord | null>;
  /** Pending or snoozed, unexpired, and not snoozed past `now`; oldest first. */
  listOpen(agentId: string, now: Date): Promise<SuggestionRecord[]>;
  /** Bounded exact identities the owner already decided or snoozed; no history scan. */
  inactiveSourceRefs(agentId: string, sourceRefs: readonly string[]): Promise<string[]>;
  /** Retire only unaccepted proposals for this exact booking occurrence. */
  supersedeBooking(agentId: string, bookingKey: string, now: Date): Promise<number>;
  /** Return a proposal only when its durable acceptance is bound to this task. */
  acceptedForTask(input: {
    agentId: string;
    suggestionId: string;
    taskId: string;
  }): Promise<SuggestionRecord | null>;
}
