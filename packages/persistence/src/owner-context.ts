import type { Records } from './records.js';

export type OwnerCardSnapshot = Pick<Records['ownerCard'], 'content' | 'compiledAt'>;
export type OwnerAmbientSnapshot = Pick<
  Records['ambientSnapshots'],
  'agentId' | 'block' | 'flags' | 'sources' | 'computedAt'
>;
export type OwnerLocationPing = Records['locationPings'];
export type OwnerCommitment = Records['commitments'];

/**
 * Read-only data needed to assemble the private context for an owner chat.
 *
 * Implementations must treat `agentId` as an authorization boundary. Rendering,
 * freshness decisions, and lexical ranking stay in core so every backend injects
 * the same prompt text from the same stored values.
 */
export interface OwnerContextRepository {
  readonly kind: 'owner-context-repository';

  getOwnerCard(agentId: string): Promise<OwnerCardSnapshot | null>;
  getAmbientSnapshot(agentId: string): Promise<OwnerAmbientSnapshot | null>;
  getLatestLocation(input: {
    agentId: string;
    notBefore: Date;
    notAfter: Date;
    source?: string;
  }): Promise<OwnerLocationPing | null>;
  /** Active candidates, newest first. Core applies query ranking and its final limit. */
  listOpenCommitments(input: {
    agentId: string;
    now: Date;
    limit: number;
  }): Promise<OwnerCommitment[]>;
}

export function isOwnerContextRepository(value: unknown): value is OwnerContextRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'owner-context-repository'
  );
}

/**
 * Writer for the one cached "right now" block per owner (`ambient.refresh`).
 * The snapshot is transient context, rebuilt every half hour; `clear` removes
 * it when no fresh location exists so stale weather is never served.
 */
export interface AmbientSnapshotRepository {
  readonly kind: 'ambient-snapshot-repository';
  save(snapshot: OwnerAmbientSnapshot): Promise<void>;
  clear(agentId: string): Promise<void>;
}

/** Synthetic visual-QA/readability sources are never owner recall evidence. */
export function isOwnerContextFixtureMessageSource(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('visual-qa:') || value.startsWith('readability-'))
  );
}

/** Missing legacy metadata is ordinary; malformed explicit metadata is unavailable. */
export function isOwnerContextFixtureConversationMetadata(value: unknown): boolean {
  if (value === undefined) return false; // Older Firestore conversations may predate metadata.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  return Object.hasOwn(value, 'visualQaRunId');
}

/**
 * Source-free legacy rows remain readable. Extraction rows carry a `v1:`
 * occurrence key and must retain their source message; owner-authored reopen
 * rows are the only sourced-occurrence exception because their authority is
 * the explicit owner reopen operation.
 */
export function isOwnerContextCommitmentSourceEligible(input: {
  agentId: unknown;
  sourceMessageId: unknown;
  sourceOccurrenceKey: unknown;
  reopenedFromId: unknown;
  reopenOperationId: unknown;
}): boolean {
  if (input.sourceMessageId !== null && input.sourceMessageId !== undefined) {
    return typeof input.sourceMessageId === 'string' && input.sourceMessageId.length > 0;
  }
  // Firestore's legacy missing nullable field decodes as undefined, which
  // has the same meaning as PostgreSQL NULL. Empty strings are malformed keys.
  if (input.sourceOccurrenceKey === null || input.sourceOccurrenceKey === undefined) {
    return true;
  }
  return (
    typeof input.agentId === 'string' &&
    typeof input.reopenOperationId === 'string' &&
    input.reopenOperationId.length > 0 &&
    typeof input.reopenedFromId === 'string' &&
    input.reopenedFromId.length > 0 &&
    input.sourceOccurrenceKey === `manual-reopen:v1:${input.agentId}:${input.reopenOperationId}`
  );
}
