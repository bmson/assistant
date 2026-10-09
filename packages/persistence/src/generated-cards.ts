import type { Records } from './records.js';

/** Optional atomic write fence for a card effect produced by a durable email observer. */
export interface EmailObserverEffectFence {
  id: string;
  agentId: string;
  claimToken: string;
  claimGeneration: number;
  expectedPrivacyGeneration: string | null;
}

/** Outbox-leg identity carried into a dashboard message append transaction. */
export interface NotificationOutboxAppendFence {
  agentId: string;
  legId: string;
  leaseToken: string;
  producerWorkId: string | null;
  producerTaskId?: string | null;
  producerApplicationId?: string | null;
  producerConfirmationMessageId?: string | null;
  producerPrivacyGeneration: string | null;
}

export class EmailObserverEffectFenceRejectedError extends Error {
  readonly code = 'email-observer-effect-fence-rejected';
  constructor() {
    super('Email observer effect fence is no longer current');
    this.name = 'EmailObserverEffectFenceRejectedError';
  }
}

/** Validate that the original prepared observer claim is still live at a dependent DB write. */
export function matchesPreparedEmailObserverClaim(
  row: {
    id: string;
    agentId: string;
    status: string;
    claimToken: string | null;
    claimGeneration: number;
    privacyGeneration: string | null;
    leaseExpiresAt: Date | null;
  } | null,
  fence: EmailObserverEffectFence,
  now: Date,
): boolean {
  return Boolean(
    row &&
      row.id === fence.id &&
      row.agentId === fence.agentId &&
      row.status === 'prepared' &&
      row.claimToken === fence.claimToken &&
      row.claimGeneration === fence.claimGeneration &&
      row.privacyGeneration === fence.expectedPrivacyGeneration &&
      row.leaseExpiresAt &&
      row.leaseExpiresAt.getTime() > now.getTime(),
  );
}

export interface GeneratedCardPersistInput {
  agentId: string;
  conversationId?: string | null;
  id: string;
  revisionId: string;
  sourceFingerprint: string;
  sourceLabel: string;
  spec: unknown;
  expiresAt: Date | null;
  targetCardId?: string;
  /** Reject a delayed refresh result if the user viewed a superseded revision. */
  targetRevisionId?: string;
  touch?: boolean;
  emailObserverEffectFence?: EmailObserverEffectFence;
}

export interface GeneratedCardPersistResult {
  card: Records['generatedCards'];
  revision: Records['generatedCardRevisions'];
}

export interface GeneratedCardRecord {
  card: Records['generatedCards'];
  revision: Records['generatedCardRevisions'];
}

export interface GeneratedCardRefresh {
  id: string;
  cardId: string;
  status: string;
  createdAt: Date;
}

export interface GeneratedCardRepository {
  readonly kind: 'generated-card-repository';
  /** Create or revise by (agentId, sourceFingerprint), atomically and idempotently. */
  createOrRevise(input: GeneratedCardPersistInput): Promise<GeneratedCardPersistResult>;
  /** Read one owner-scoped active card and its current immutable revision. */
  get(agentId: string, cardId: string): Promise<GeneratedCardRecord | null>;
  /** Owner-scoped current active cards with their current immutable revision. */
  list(agentId: string, now?: Date, ids?: string[]): Promise<GeneratedCardRecord[]>;
  /** Latest refresh attempts for the requested owner-scoped cards. */
  listRefreshes(agentId: string, cardIds: string[]): Promise<GeneratedCardRefresh[]>;
  /** Dismiss only a card belonging to the requested agent. */
  dismiss(agentId: string, cardId: string, now?: Date): Promise<boolean>;
}
