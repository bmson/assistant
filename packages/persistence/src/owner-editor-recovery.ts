import type { OwnerEditorScope, OwnerEditorSessionView } from './owner-editor.js';

/** Storage-only contract. It does not grant HTTP, issuance or apply admission. */
export interface OwnerEditorRecoveryCurrentState {
  ownerId: string;
  epoch: string;
  privacyGeneration: string | null;
  ready: boolean;
}
export interface OwnerEditorRecoveryMaintenanceState {
  driver: 'firestore' | 'postgres';
  releaseWritesPaused: boolean;
  restoreRehearsal: boolean;
  postgresSourceWritesFenced: boolean;
}
export interface OwnerEditorRecoveryFreshSnapshot {
  current: OwnerEditorRecoveryCurrentState;
  maintenance: OwnerEditorRecoveryMaintenanceState;
  operation: unknown;
}
export interface OwnerEditorExpiredClaimExpectation {
  scope: OwnerEditorScope;
  session: OwnerEditorSessionView;
  requestHash: string;
  claimToken: string;
  claimExpiresAt: Date;
  statusVersion: number;
  /** Caller observation, never a substitute for the adapter's admission clock. */
  now: Date;
  proofExpiresAt: Date;
  replayExpiresAt: Date;
  maintenance: OwnerEditorRecoveryMaintenanceState;
}
/** Only one original journal transition; no reserve/apply or primary writer. */
export interface OwnerEditorRecoveryTransaction {
  readFresh(): Promise<OwnerEditorRecoveryFreshSnapshot>;
  abandonExpiredOriginal(expected: OwnerEditorExpiredClaimExpectation): Promise<unknown | null>;
}
export interface OwnerEditorRecoveryStorage {
  withRecoveryTransaction<T>(
    scope: OwnerEditorScope,
    run: (transaction: OwnerEditorRecoveryTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface OwnerEditorRecoveryStorageOptions {
  /** Local configured flags only, not a durable global pause authority. */
  readMaintenance(): Promise<unknown>;
  /** Revalidate this request through existing auth APIs, without bypassing caches. */
  authorize(scope: OwnerEditorScope, expectedSession?: OwnerEditorSessionView): Promise<boolean>;
  /** Firestore admission clock; PostgreSQL uses its database clock at UPDATE. */
  now?: () => Date;
}
