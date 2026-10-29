/** Portable contracts for owner-authored People, Family, and Memory commands. */
export const OWNER_EDITOR_COMMANDS = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const;
/**
 * Shared UI command names. The release parser's OWNER_EDITOR_COMMANDS remains
 * the narrower set of commands with current wire/storage implementations.
 */
export type OwnerEditorCommand =
  | (typeof OWNER_EDITOR_COMMANDS)[number]
  | 'remove_person'
  | 'remove_owner_family_relationship';
export type OwnerEditorTiming = 'unspecified' | 'present' | 'past';

/** Civil dates, validated before conversion; null means not recorded. */
export interface OwnerEditorValidity {
  validFrom: string | null;
  validUntil: string | null;
}
export type OwnerEditorCanonicalExpectation =
  | { kind: 'absent' }
  | { kind: 'revision'; revision: string };
export interface OwnerEditorFamilyFields {
  subjectContactId: string;
  objectContactId: string;
  expectedSubjectRevision: string;
  expectedObjectRevision: string;
  predicate: string;
  timing: OwnerEditorTiming;
  validity: OwnerEditorValidity;
  note: string;
  expectedCanonicalState: OwnerEditorCanonicalExpectation;
}
interface ApplyEnvelope {
  version: 1;
  intent: 'apply';
  operationId: string;
}
export type OwnerEditorApply = ApplyEnvelope &
  (
    | { command: 'create_person'; name: string; aliases: string[] }
    | {
        command: 'update_person_identity';
        contactId: string;
        expectedContactRevision: string;
        name: string;
        aliases: string[];
      }
    | ({ command: 'add_family_relationship' } & OwnerEditorFamilyFields)
    | {
        command: 'correct_owner_family_relationship';
        targetRelationId: string;
        expectedTargetRevision: string;
        replacement: OwnerEditorFamilyFields;
      }
    | {
        command: 'remove_person';
        contactId: string;
        expectedContactRevision: string;
        expectedImpactRevision: string;
      }
    | {
        command: 'remove_owner_family_relationship';
        targetRelationId: string;
        expectedTargetRevision: string;
      }
    | {
        command: 'correct_owner_memory';
        memoryId: string;
        expectedContentHash: string;
        expectedMemoryRevision: string;
        content: string;
      }
  );
/** Resolves a stored request; this body cannot prepare or change a draft. */
export interface OwnerEditorReconcile {
  version: 1;
  intent: 'reconcile';
  command: OwnerEditorCommand;
  operationId: string;
  receiptBindingToken: string;
}
export type OwnerEditorRequest = OwnerEditorApply | OwnerEditorReconcile;
export interface OwnerEditorSavedIds {
  contactId?: string;
  relationId?: string;
  previousRelationId?: string;
  memoryId?: string;
  assertionId?: string;
}
/** Compact persisted outcomes contain no name, note, draft or current summary. */
export type OwnerEditorTerminalResult =
  | {
      outcome: 'saved' | 'unchanged';
      ids: OwnerEditorSavedIds;
      /** Committed operation identity, NOT a contact/graph snapshot CAS token. */
      revision: string;
      refreshPending?: boolean;
    }
  | { outcome: 'conflict'; reason: string }
  | { outcome: 'invalid'; fieldErrors: Record<string, string> }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'not_applied'; reason: 'claim_abandoned' | 'preparation_failed' };
export interface OwnerEditorReplyIdentity {
  version: 1;
  command: OwnerEditorCommand;
  operationId: string;
}
export type OwnerEditorReceiptReply = OwnerEditorReplyIdentity &
  OwnerEditorTerminalResult & {
    authority: 'operation_receipt';
    requestHash: string;
    statusVersion: number;
  };
export type OwnerEditorReply =
  | OwnerEditorReceiptReply
  | (OwnerEditorReplyIdentity & {
      authority: 'scope_retirement';
      outcome: 'voided';
      reason: 'scope_retired' | 'replay_window_retired';
    })
  | {
      version: 1;
      authority: 'request_rejection';
      command: OwnerEditorCommand | null;
      operationId: string | null;
      outcome: 'invalid' | 'conflict' | 'unavailable';
      originalOperationTerminal: false;
      reason: string;
      fieldErrors?: Record<string, string>;
    }
  | (OwnerEditorReplyIdentity & {
      authority: 'unresolved';
      outcome: 'outcome_unknown';
      reason: 'preparing' | 'receipt_unavailable' | 'proof_changed' | 'receipt_missing';
      receiptBindingToken?: string;
    });
/** Verified issuance metadata is freshness, never a replacement for owner checks. */
export interface OwnerEditorScope {
  ownerId: string;
  sessionDigest: string;
  epoch: string;
  privacyGeneration: string | null;
  command: OwnerEditorCommand;
  operationId: string;
  targetId: string | null;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
export interface OwnerEditorClaim {
  scope: OwnerEditorScope;
  requestHash: string;
  claimToken: string;
  claimExpiresAt: Date;
  statusVersion: number;
}
export interface OwnerEditorOperationRecord {
  id: string;
  ownerId: string;
  epoch: string;
  privacyGenerationDigest: string;
  operationId: string;
  requestHash: string;
  scopeDigest: string;
  command: OwnerEditorCommand;
  protocolVersion: 1;
  formIssuedAt: Date;
  formExpiresAt: Date;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  status: 'preparing' | 'committed' | 'terminal_rejected' | 'abandoned';
  statusVersion: number;
  result: OwnerEditorTerminalResult | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface OwnerEditorReceiptProof {
  scope: OwnerEditorScope;
  requestHash: string;
  claimIdentityDigest: string;
  statusVersion: number;
  issuedAt: number;
  expiresAt: number;
}
export type OwnerEditorReservation =
  | { kind: 'claimed'; claim: OwnerEditorClaim }
  | { kind: 'reply'; reply: OwnerEditorReply };
export interface OwnerEditorLookup {
  reply: OwnerEditorReply;
  /** Server-only proof material; never serialize this record to the browser. */
  operation: OwnerEditorOperationRecord | null;
}
export type OwnerEditorAtomicAdmission =
  | { kind: 'admitted'; claim: OwnerEditorClaim; operation: OwnerEditorOperationRecord }
  | { kind: 'reply'; reply: OwnerEditorReply };
/**
 * Short reservation/lookup/abandon transactions. Successful domain writes must
 * verify the live claim and publish the terminal receipt in THEIR transaction.
 */
export interface OwnerEditorOperationRepository {
  readonly kind: 'owner-editor-operation-repository';
  reserve(scope: OwnerEditorScope, requestHash: string, now: Date): Promise<OwnerEditorReservation>;
  lookup(scope: OwnerEditorScope, now: Date): Promise<OwnerEditorLookup>;
  reconcile(proof: OwnerEditorReceiptProof, now: Date): Promise<OwnerEditorReply>;
  failPreparation(
    claim: OwnerEditorClaim,
    result: Extract<OwnerEditorTerminalResult, { outcome: 'invalid' | 'conflict' | 'unavailable' }>,
    now: Date,
  ): Promise<OwnerEditorReply>;
}
export interface OwnerEditorPersonOption {
  contactId: string;
  name: string;
  revision: string;
}
/** Server-issued once per displayed operation; it contains no private draft. */
export interface OwnerEditorFormGrant {
  command: OwnerEditorCommand;
  operationId: string;
  issuedOperationHandle: string;
}
export interface OwnerEditorSessionView {
  ownerId: string;
  formSessionScope: string;
}
export interface OwnerEditorIssuanceContext {
  ownerId: string;
  epoch: string;
  privacyGeneration: string | null;
}
export interface OwnerEditorCorrectionEligibility {
  relationId: string;
  revision: string;
  original: OwnerEditorFamilyFields;
  sourceText: string;
}

/** Exact bounded preview data; it is not itself removal authority. */
export interface OwnerEditorPersonRemovalImpact {
  contactId: string;
  revision: string;
  facts: number;
  occasions: number;
  connections: number;
  retainedSourceNotes: number;
  entityLinks: number;
  sourceLinks: number;
}
