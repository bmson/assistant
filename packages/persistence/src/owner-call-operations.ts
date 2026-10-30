import type {
  OwnerCallGrantOperation,
  OwnerCallGrantOperationSlot,
} from './owner-call-operation-receipt.js';

/** Exact owner/approval/operation identity; never an authority to approve the call. */
export interface OwnerCallOperationBinding {
  ownerId: string;
  approvalId: string;
  grantId: string;
  taskId: string;
  toolCallId: string;
  slotGeneration: number;
  requestFingerprint: string;
  grantScopeFingerprint: string;
}

export interface OwnerCallOperationRegisterInput
  extends Omit<OwnerCallOperationBinding, 'slotGeneration'> {
  expectedSlotGeneration: number;
  reviewExpiresAt: Date;
  grantExpiresAt: Date;
  /** Explicit replacement may close only an operation that was never admitted. */
  replaceUnadmittedRegistration: boolean;
}

export type OwnerCallOperationWriteResult =
  | { ok: true; operation: OwnerCallGrantOperation }
  | { ok: false; reason: string };

export type OwnerCallOperationDiscovery =
  | { kind: 'empty'; generation: 0 }
  | { kind: 'current'; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation }
  | { kind: 'unavailable' };

/** Authenticated caller supplies the owner. Every adapter rechecks exact owned records. */
export interface OwnerCallGrantOperationRepository {
  discover(ownerId: string, approvalId: string): Promise<OwnerCallOperationDiscovery>;
  register(input: OwnerCallOperationRegisterInput): Promise<OwnerCallOperationWriteResult>;
  admit(binding: OwnerCallOperationBinding): Promise<OwnerCallOperationWriteResult>;
  close(binding: OwnerCallOperationBinding): Promise<OwnerCallOperationWriteResult>;
}
