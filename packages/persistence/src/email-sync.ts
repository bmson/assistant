import { Buffer } from 'node:buffer';
import type { AppendMessageInput } from './contracts.js';
import type { Records } from './records.js';
import type {
  SecurityIncidentAttentionCandidate,
  SecurityIncidentObservation,
  SecurityIncidentRecord,
  SecurityIncidentSourceRecord,
} from './security-incidents.js';

export interface EmailSyncState {
  lastHistoryId: bigint | null;
  /** The durable drain cursor; empty or null when no drain is in progress. */
  cursor: unknown;
}

export type EmailIngestRecord = Pick<
  Records['emailIngest'],
  | 'id'
  | 'agentId'
  | 'providerMessageId'
  | 'conversationId'
  | 'importance'
  | 'category'
  | 'contentTrust'
  | 'triaged'
  | 'actionable'
  | 'reason'
  | 'dates'
  | 'cardCandidate'
  | 'nextStep'
  | 'pipelineStage'
  | 'scoreStatus'
  | 'scoreClaimToken'
  | 'messagePersisted'
  | 'triageTaskId'
  | 'providerThreadId'
  | 'providerReceivedAt'
  | 'sourceMessageId'
  | 'obligationStatus'
  | 'obligationVersion'
  | 'obligationDecision'
  | 'obligationDecisionAt'
  | 'obligationSnoozedUntil'
  | 'securityEvidence'
  | 'securityIncidentId'
  | 'classificationStatus'
  | 'classificationClaimToken'
  | 'preparedClassification'
  | 'scoreOutcome'
  | 'ingestMode'
  | 'hasExternalOrUnknown'
  | 'observerRegistrySnapshot'
  | 'observerRegistryHash'
  | 'admittedSourceKind'
  | 'admittedSourceId'
  | 'directRouting'
  | 'directRecoveryReason'
  | 'emailContentProvenance'
>;

export type EmailBookingOccurrenceRecord = Records['emailBookingOccurrences'];

export type EmailObligationDecision = 'confirm_open' | 'resolve' | 'snooze' | 'reopen';

export type EmailObligationRecord = Pick<
  Records['emailIngest'],
  | 'id'
  | 'channelMessageId'
  | 'providerThreadId'
  | 'providerReceivedAt'
  | 'subject'
  | 'fromEmail'
  | 'fromName'
  | 'obligationStatus'
  | 'obligationVersion'
  | 'obligationDecision'
  | 'obligationDecisionAt'
  | 'obligationSnoozedUntil'
>;

export type PreparedEmailScore = Pick<
  Records['emailIngest'],
  'category' | 'importance' | 'actionable' | 'reason' | 'dates' | 'cardCandidate' | 'nextStep'
> &
  Partial<Pick<Records['emailIngest'], 'securityEvidence'>>;

export type NewEmailIngest = Pick<
  Records['emailIngest'],
  | 'agentId'
  | 'conversationId'
  | 'channelMessageId'
  | 'fromEmail'
  | 'fromName'
  | 'subject'
  | 'contentTrust'
  | 'authenticated'
  | 'category'
  | 'importance'
  | 'actionable'
  | 'reason'
  | 'dates'
> &
  Partial<
    Pick<
      Records['emailIngest'],
      | 'mailbox'
      | 'providerMessageId'
      | 'pipelineStage'
      | 'scoreStatus'
      | 'scoreClaimToken'
      | 'cardCandidate'
      | 'nextStep'
      | 'messagePersisted'
      | 'triageTaskId'
      | 'providerThreadId'
      | 'providerReceivedAt'
      | 'sourceMessageId'
      | 'securityEvidence'
      | 'securityIncidentId'
      | 'classificationStatus'
      | 'classificationClaimToken'
      | 'preparedClassification'
      | 'scoreOutcome'
      | 'ingestMode'
      | 'hasExternalOrUnknown'
      | 'observerRegistrySnapshot'
      | 'observerRegistryHash'
      | 'admittedSourceKind'
      | 'admittedSourceId'
      | 'directRouting'
      | 'directRecoveryReason'
      | 'emailContentProvenance'
    >
  >;

export type DirectEmailRouting = 'application_confirmation' | 'email_triage' | 'needs_attention';
export type DirectEmailRecoveryReason =
  | 'provider_message_missing'
  | 'provider_access_denied'
  | 'provider_temporarily_unavailable'
  | 'checkpoint_inconsistent';

/** Bounded, body-free subset needed to preserve MIME/source trust on recovery. */
export interface EmailContentProvenanceSnapshot {
  version: 1;
  mode: 'direct' | 'forwarded';
  authenticated: boolean;
  sourceLength: number;
  storedLength: number;
  sourceHash: string;
  bodyHash: string;
  messageHash: string;
  prefixLength: number;
  hasExternalOrUnknown: boolean;
  spans: Array<{ start: number; end: number; author: 'sender' | 'external' | 'unknown' }>;
  parts: Array<{
    path: string;
    mimeType: string;
    quoteMarkup: boolean;
    replyHeaders: boolean;
    bodyQuoteStart?: number;
  }>;
}

export function isValidEmailContentProvenanceSnapshot(
  value: unknown,
): value is EmailContentProvenanceSnapshot {
  try {
    const json = JSON.stringify(value);
    if (
      !json ||
      Buffer.byteLength(json, 'utf8') > 64 * 1024 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return false;
    const row = value as Record<string, unknown>;
    const hash = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item);
    if (
      row.version !== 1 ||
      !['direct', 'forwarded'].includes(String(row.mode)) ||
      typeof row.authenticated !== 'boolean' ||
      !Number.isSafeInteger(row.sourceLength) ||
      Number(row.sourceLength) < 0 ||
      !Number.isSafeInteger(row.storedLength) ||
      Number(row.storedLength) < 0 ||
      !Number.isSafeInteger(row.prefixLength) ||
      Number(row.prefixLength) < 0 ||
      Number(row.storedLength) > Number(row.sourceLength) ||
      typeof row.hasExternalOrUnknown !== 'boolean' ||
      !hash(row.sourceHash) ||
      !hash(row.bodyHash) ||
      !hash(row.messageHash) ||
      !Array.isArray(row.spans) ||
      row.spans.length > 256 ||
      !Array.isArray(row.parts) ||
      row.parts.length > 256
    )
      return false;
    if (
      !row.spans.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const span = entry as Record<string, unknown>;
        return (
          Number.isSafeInteger(span.start) &&
          Number(span.start) >= 0 &&
          Number.isSafeInteger(span.end) &&
          Number(span.end) >= Number(span.start) &&
          Number(span.end) <= Number(row.storedLength) &&
          ['sender', 'external', 'unknown'].includes(String(span.author))
        );
      })
    )
      return false;
    return row.parts.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const part = entry as Record<string, unknown>;
      return (
        typeof part.path === 'string' &&
        part.path.length <= 256 &&
        typeof part.mimeType === 'string' &&
        part.mimeType.length <= 256 &&
        typeof part.quoteMarkup === 'boolean' &&
        typeof part.replyHeaders === 'boolean' &&
        (part.bodyQuoteStart === undefined ||
          (Number.isSafeInteger(part.bodyQuoteStart) &&
            Number(part.bodyQuoteStart) >= 0 &&
            Number(part.bodyQuoteStart) <= Number(row.storedLength)))
      );
    });
  } catch {
    return false;
  }
}

export type EmailObserverWorkClass = 'idempotent_db' | 'paid_ambiguous' | 'external_provider';
export type EmailObserverWorkStatus =
  | 'pending'
  | 'claimed'
  | 'prepared'
  | 'complete'
  | 'no_op'
  | 'retryable_failed'
  | 'unknown'
  | 'skipped_erased'
  | 'skipped_budget';

export interface EmailObserverIdentity {
  key: string;
  version: number;
  workClass: EmailObserverWorkClass;
}

export type EmailAdmissionSource =
  | { kind: 'message'; message: AppendMessageInput & { channelMessageId: string } }
  | { kind: 'automated_source'; body: string };

export interface EmailObserverWorkRecord {
  id: string;
  agentId: string;
  sourceKey: string;
  channelMessageId: string;
  sourceKind: 'message' | 'automated_source';
  observerKey: string;
  observerVersion: number;
  workClass: EmailObserverWorkClass;
  status: EmailObserverWorkStatus;
  attemptCount: number;
  claimToken: string | null;
  claimGeneration: number;
  leaseExpiresAt: Date | null;
  privacyGeneration: string | null;
  budgetKey: string | null;
  budgetWindowStart: Date | null;
  budgetReserved: boolean;
  preparedResult: unknown | null;
  deliveryKey: string | null;
  lastErrorCode: string | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailObserverClaim extends EmailObserverWorkRecord {
  status: 'claimed' | 'prepared';
  claimToken: string;
  leaseExpiresAt: Date;
}

export interface EmailObserverSource {
  agentId: string;
  messageId: string | null;
  sourceId: string;
  from: string;
  subject: string;
  body: string;
  authenticated: boolean;
  origin: Records['messages']['origin'] | null;
  contentTrust: 'owner' | 'known' | 'unknown';
  directRouting?: DirectEmailRouting | null;
  emailContentProvenance?: EmailContentProvenanceSnapshot | null;
  ingestMode: 'direct' | 'forwarded';
  sourceVerification: 'authenticated' | 'forwarded_unverified';
  hasExternalOrUnknown: boolean;
}

export interface EmailObserverBudgetInput {
  /** Stable module config key; must equal the registered observerKey. */
  budgetKey: string;
  observerKey: string;
  limit: number;
  windowStart: Date;
  windowEnd: Date;
}

export type EmailObserverClaimResult =
  | { kind: 'claimed'; claim: EmailObserverClaim }
  | { kind: 'skipped_budget'; id: string }
  | { kind: 'none' };

export interface EmailObserverClaimNextInput {
  agentId: string;
  token: string;
  now: Date;
  leaseMs: number;
  limit?: number;
  expectedPrivacyGeneration: string | null;
  paidBudget?: EmailObserverBudgetInput;
}

export interface EmailObserverTransitionInput {
  id: string;
  agentId: string;
  claimToken: string;
  claimGeneration: number;
  expectedPrivacyGeneration: string | null;
  now: Date;
}

export interface EmailObserverPrepareInput extends EmailObserverTransitionInput {
  result: unknown;
}

export interface RecoverableDirectIngest {
  id: string;
  agentId: string;
  mailbox: string;
  channelMessageId: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  sourceMessageId: string | null;
  conversationId: string | null;
  authenticated: true;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  contentTrust: 'owner' | 'known' | 'unknown';
  hasExternalOrUnknown: boolean;
  emailContentProvenance: EmailContentProvenanceSnapshot | null;
  directRouting: DirectEmailRouting | null;
  directRecoveryReason: DirectEmailRecoveryReason | null;
  classificationStatus: 'pending' | 'in_progress' | 'prepared' | 'unknown';
  classificationClaimToken: string | null;
  preparedClassification: { automated: boolean } | null;
  scoreStatus: 'pending' | 'in_progress' | 'prepared' | 'unknown';
  scoreClaimToken: string | null;
  scoreOutcome: string;
  score: PreparedEmailScore | null;
  pipelineStage: string;
  admittedSourceKind: null;
  admittedSourceId: null;
  messagePersisted: false;
  updatedAt: Date;
}

export interface ListRecoverableDirectIngestsInput {
  agentId: string;
  mailbox: string;
  expectedPrivacyGeneration: string | null;
  lease: EmailSyncLease;
  limit: number;
}

export interface MarkDirectIngestRecoveryUnavailableInput {
  agentId: string;
  mailbox: string;
  ingestId: string;
  expectedPrivacyGeneration: string | null;
  lease: EmailSyncLease;
  reason: DirectEmailRecoveryReason;
}

export interface EmailAdmissionCommitInput {
  agentId: string;
  ingestId: string;
  scoreClaimToken: string;
  source: EmailAdmissionSource;
  finalizedIngest: NewEmailIngest;
  observers: readonly EmailObserverIdentity[];
  expectedPrivacyGeneration: string | null;
  lease?: EmailSyncLease;
}

export interface EmailAdmissionCommitResult {
  messageId: string | null;
  sourceId: string;
  ingestId: string;
  observerIds: string[];
  duplicate: boolean;
}

export interface EmailObserverBudgetBucket {
  id: string;
  agentId: string;
  observerKey: string;
  utcWindowStart: Date;
  utcWindowEnd: Date;
  reservedCount: number;
  limit: number;
  createdAt: Date;
  updatedAt: Date;
}

export type SecurityIncidentObservationResult = {
  incident: SecurityIncidentRecord;
  source: SecurityIncidentSourceRecord;
  duplicateEvidence: boolean;
  reassessmentReason: string | null;
};

/** A mailbox drain lease. Repository callbacks revalidate this generation
 * before extending or committing a checkpoint. */
export interface EmailSyncLease {
  readonly holder: string;
  readonly generation: number;
  /** Extend the bounded lease, rejecting if another worker has taken over. */
  renew(): Promise<void>;
  /** Fail if the original lock is no longer current. */
  assertCurrent(): Promise<void>;
}

/**
 * Gmail sync's own state: the owner mailbox, its history cursor, the
 * single-flight lock, email thread conversations, and the `emailIngest`
 * ledger the briefing, pulse and memory extraction read.
 */
export interface EmailSyncRepository {
  readonly kind: 'email-sync-repository';
  /** Privacy-erasure generation captured before provider-backed source reads. */
  privacyObservationFence?(agentId: string): Promise<string | null>;
  /** The owner agent, its name for the From header, and the mailbox it syncs. */
  mailbox(): Promise<{ agentId: string; name: string; email: string }>;
  /** Addresses of owner and known contacts, lowercased. */
  contactTrust(): Promise<Array<{ email: string; trust: 'owner' | 'known' }>>;
  syncState(mailbox: string): Promise<EmailSyncState | null>;
  /** Raise the history baseline (never lower it), creating the state on first sync. */
  raiseBaseline(mailbox: string, historyId: bigint, lease: EmailSyncLease): Promise<void>;
  saveCursor(mailbox: string, cursor: unknown, lease: EmailSyncLease): Promise<void>;
  /** Finish a drain: raise the baseline to the drain's target and clear the cursor. */
  completeDrain(mailbox: string, targetHistoryId: bigint, lease: EmailSyncLease): Promise<void>;
  setWatchExpiration(mailbox: string, expiration: Date): Promise<void>;
  /**
   * Run while holding the cross-instance mailbox lock. Returns null without
   * running when another instance holds it.
   */
  withLock<T>(run: (lease: EmailSyncLease) => Promise<T>): Promise<{ value: T } | null>;
  /** The stored inbound message for a Gmail id, if one was persisted. */
  inboundMessage(
    channelMessageId: string,
  ): Promise<{ conversationId: string; origin: string } | null>;
  /** Whether any task already carries this external event id. */
  hasTaskForEvent(externalEventId: string): Promise<boolean>;
  /** The conversation bound to an email thread, created with its binding on first contact. */
  conversationForThread(
    agentId: string,
    threadId: string,
    trust: string,
    subject: string,
    options?: { expectedPrivacyGeneration: string | null },
  ): Promise<string>;
  ingestRecord(channelMessageId: string): Promise<EmailIngestRecord | null>;
  /** Bounded metadata-only scan for resumable direct checkpoints under the live mailbox/privacy fence. */
  listRecoverableDirectIngests(
    input: ListRecoverableDirectIngestsInput,
  ): Promise<RecoverableDirectIngest[]>;
  /** Terminalize a missing/changed provider source without admitting or exposing a body. */
  markDirectIngestRecoveryUnavailable(
    input: MarkDirectIngestRecoveryUnavailableInput,
  ): Promise<boolean>;
  /** Create the durable source/scoring checkpoint before invoking a paid scorer. */
  beginForwardedIngest(
    row: NewEmailIngest & { mailbox: string; providerMessageId: string },
    options?: { expectedPrivacyGeneration: string | null; lease?: EmailSyncLease },
  ): Promise<EmailIngestRecord>;
  beginDirectEmailIngest(
    row: NewEmailIngest & { mailbox: string; providerMessageId: string },
    input: { expectedPrivacyGeneration: string | null; lease?: EmailSyncLease },
  ): Promise<EmailIngestRecord>;
  claimIngestClassification(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<boolean>;
  prepareIngestClassification(
    agentId: string,
    ingestId: string,
    token: string,
    result: { automated: boolean },
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  markIngestClassificationUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    fallback: { automated: boolean } | null,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Claim the only scoring attempt; false means read the durable stage and do not score. */
  claimIngestScore(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
    claimOutcome?: 'model_prepared' | 'deterministic_no_model',
  ): Promise<boolean>;
  /** Return a provider claim only when the router definitively made no call. */
  markIngestScoreBudgetBlocked(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Fence an abandoned scorer as ambiguous instead of silently charging again. */
  markIngestScoreUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Save the full model verdict before the source message can be committed. */
  prepareIngestScore(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
    expectedClaimOutcome?: 'model_prepared' | 'deterministic_no_model',
  ): Promise<void>;
  /** Save a deterministic no-model verdict only after a matching deterministic claim. */
  prepareIngestScoreDeterministic(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Persist a deterministic fail-open value without relabeling an ambiguous paid attempt as prepared. */
  prepareIngestScoreFallbackUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Adopt a committed source message after a crash between message and checkpoint writes. */
  markIngestMessagePersisted(
    ingestId: string,
    conversationId: string,
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Mark a no-triage decision complete, or record the durable task receipt. */
  completeForwardedIngest(
    ingestId: string,
    input: { triaged: boolean; taskId?: string | null; now: Date },
    lease?: EmailSyncLease,
  ): Promise<void>;
  /** Record a verdict once per Gmail id. Returns its id, or null when it already existed. */
  recordIngest(row: NewEmailIngest, observationFence?: string | null): Promise<string | null>;
  commitEmailAdmission(input: EmailAdmissionCommitInput): Promise<EmailAdmissionCommitResult>;
  listDueEmailObservers(
    agentId: string,
    now: Date,
    limit: number,
    excludedObserverIdentities?: readonly EmailObserverIdentity[],
  ): Promise<EmailObserverWorkRecord[]>;
  claimEmailObserver(input: {
    id: string;
    agentId: string;
    token: string;
    now: Date;
    leaseMs: number;
    expectedPrivacyGeneration: string | null;
    paidBudget?: EmailObserverBudgetInput;
  }): Promise<EmailObserverClaimResult>;
  claimNextEmailObserver(input: EmailObserverClaimNextInput): Promise<EmailObserverClaimResult>;
  loadEmailObserverSource(claim: EmailObserverClaim): Promise<EmailObserverSource | null>;
  prepareEmailObserver(input: EmailObserverPrepareInput): Promise<boolean>;
  completeEmailObserver(input: EmailObserverTransitionInput): Promise<boolean>;
  failEmailObserver(
    input: EmailObserverTransitionInput & {
      /** budget_blocked is only for a known no-provider attempt and refunds its reservation. */
      outcome: 'retryable_failed' | 'unknown' | 'no_op' | 'budget_blocked';
      errorCode?: string;
    },
  ): Promise<boolean>;
  eraseEmailObserverData(
    agentId: string,
    newPrivacyGeneration: string,
    now: Date,
  ): Promise<{ workRows: number; sources: number }>;
  /** Link one completed security source to a provenance-backed incident. */
  observeSecurityIncident(
    input: SecurityIncidentObservation,
  ): Promise<SecurityIncidentObservationResult>;
  securityIncidentForMessage(
    agentId: string,
    channelMessageId: string,
  ): Promise<SecurityIncidentRecord | null>;
  /** Pending current-revision incidents for the briefing lane; never includes
   * a source body or an incident already claimed by any producer. */
  listSecurityAttentionCandidates(
    agentId: string,
    limit: number,
  ): Promise<SecurityIncidentAttentionCandidate[]>;
  /** One admission fence shared by arrival, pulse, and briefing. */
  claimSecurityAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    producer: 'arrival' | 'pulse' | 'briefing';
    now: Date;
  }): Promise<boolean>;
  completeSecurityAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    deliveryStatus: 'accepted' | 'unknown';
    now: Date;
  }): Promise<boolean>;
  decideSecurityIncident(input: {
    agentId: string;
    incidentId: string;
    expectedRevision: number;
    disposition: 'expected' | 'dismissed';
    reason: string;
    now: Date;
  }): Promise<boolean>;
  /** Current thread obligations only; legacy classifier-only rows stay unknown. */
  listEmailObligations(now: Date): Promise<EmailObligationRecord[]>;
  /** Owner decision CAS. Rejects stale source IDs and revisions. */
  decideEmailObligation(input: {
    channelMessageId: string;
    expectedVersion: number;
    decision: EmailObligationDecision;
    now: Date;
    snoozedUntil?: Date;
  }): Promise<boolean>;
  /** Current occurrence token used to fence accepted mail-derived calendar tasks. */
  isBookingOccurrenceCurrent(input: {
    agentId: string;
    bookingKey: string;
    expectedVersion: number;
    allowedLifecycle?: readonly string[];
  }): Promise<boolean>;
  /** Ingest rows marked triaged since `since`, for the daily triage ceiling. */
  triagedSince(since: Date): Promise<number>;
  markTriaged(ingestId: string, now: Date): Promise<void>;
  /**
   * Where an email conversation replies: its channel, the Gmail thread it is
   * bound to, and the trigger of its earliest owner-trust email_triage task.
   */
  replyThread(conversationId: string): Promise<{
    channel: string;
    threadId: string | null;
    ownerOriginTrigger: unknown;
  } | null>;
}
