import { compareExactTimestamps, isValidExactTimestamp } from './exact-timestamp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/;

/** Storage namespace v1; distinct from review-purpose/version 2 and legacy stateless schema 1. */
export const OWNER_CALL_OPERATION_SCHEMA_VERSION = 1 as const;
/** Operation protocol v1 is only valid inside the explicit owner-call-grant-operation.v1 namespace. */
export const OWNER_CALL_OPERATION_VERSION = 1 as const;
export const OWNER_CALL_OPERATION_PURPOSE = 'owner-call-grant-operation.v1' as const;

export const OWNER_CALL_OPERATION_PHASES = [
  'registered',
  'admitted',
  'committed',
  'closed_no_effect',
  'rejected_no_effect',
] as const;

export type OwnerCallGrantOperationPhase = (typeof OWNER_CALL_OPERATION_PHASES)[number];

/** Per-approval CAS pointer; terminal receipts remain addressable until a later register. */
export interface OwnerCallGrantOperationSlot {
  purpose: typeof OWNER_CALL_OPERATION_PURPOSE;
  schemaVersion: typeof OWNER_CALL_OPERATION_SCHEMA_VERSION;
  ownerId: string;
  approvalId: string;
  generation: number;
  currentGrantId: string | null;
  updatedAt: Date;
}

/** Content-free receipt for one exact reusable-call operation. */
export interface OwnerCallGrantOperation {
  purpose: typeof OWNER_CALL_OPERATION_PURPOSE;
  schemaVersion: typeof OWNER_CALL_OPERATION_SCHEMA_VERSION;
  operationVersion: typeof OWNER_CALL_OPERATION_VERSION;
  ownerId: string;
  approvalId: string;
  grantId: string;
  taskId: string;
  toolCallId: string;
  slotGeneration: number;
  requestFingerprint: string;
  grantScopeFingerprint: string;
  phase: OwnerCallGrantOperationPhase;
  registeredAt: Date;
  reviewExpiresAt: Date;
  grantExpiresAt: Date;
  admittedAt: Date | null;
  committedAt: Date | null;
  closedAt: Date | null;
  rejectedAt: Date | null;
  createdPolicyId: string | null;
  wakeGeneration: number | null;
  updatedAt: Date;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDate(value: unknown): value is Date {
  return isValidExactTimestamp(value);
}

function isNullableDate(value: unknown): value is Date | null {
  return value === null || isDate(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID.test(value));
}

const SLOT_KEYS = [
  'purpose',
  'schemaVersion',
  'ownerId',
  'approvalId',
  'generation',
  'currentGrantId',
  'updatedAt',
] as const;

const OPERATION_KEYS = [
  'purpose',
  'schemaVersion',
  'operationVersion',
  'ownerId',
  'approvalId',
  'grantId',
  'taskId',
  'toolCallId',
  'slotGeneration',
  'requestFingerprint',
  'grantScopeFingerprint',
  'phase',
  'registeredAt',
  'reviewExpiresAt',
  'grantExpiresAt',
  'admittedAt',
  'committedAt',
  'closedAt',
  'rejectedAt',
  'createdPolicyId',
  'wakeGeneration',
  'updatedAt',
] as const;

export function parseOwnerCallGrantOperationSlot(
  value: unknown,
): OwnerCallGrantOperationSlot | null {
  if (!plainRecord(value) || !hasExactKeys(value, SLOT_KEYS)) return null;
  if (
    value.purpose !== OWNER_CALL_OPERATION_PURPOSE ||
    value.schemaVersion !== OWNER_CALL_OPERATION_SCHEMA_VERSION ||
    typeof value.ownerId !== 'string' ||
    !UUID.test(value.ownerId) ||
    typeof value.approvalId !== 'string' ||
    !UUID.test(value.approvalId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !isNullableUuid(value.currentGrantId) ||
    ((value.generation as number) === 0) !== (value.currentGrantId === null) ||
    !isDate(value.updatedAt)
  )
    return null;
  return value as unknown as OwnerCallGrantOperationSlot;
}

export function parseOwnerCallGrantOperation(value: unknown): OwnerCallGrantOperation | null {
  if (!plainRecord(value) || !hasExactKeys(value, OPERATION_KEYS)) return null;
  if (
    value.purpose !== OWNER_CALL_OPERATION_PURPOSE ||
    value.schemaVersion !== OWNER_CALL_OPERATION_SCHEMA_VERSION ||
    value.operationVersion !== OWNER_CALL_OPERATION_VERSION ||
    typeof value.ownerId !== 'string' ||
    !UUID.test(value.ownerId) ||
    typeof value.approvalId !== 'string' ||
    !UUID.test(value.approvalId) ||
    typeof value.grantId !== 'string' ||
    !UUID.test(value.grantId) ||
    typeof value.taskId !== 'string' ||
    !UUID.test(value.taskId) ||
    typeof value.toolCallId !== 'string' ||
    !UUID.test(value.toolCallId) ||
    !Number.isSafeInteger(value.slotGeneration) ||
    (value.slotGeneration as number) < 1 ||
    typeof value.requestFingerprint !== 'string' ||
    !FINGERPRINT.test(value.requestFingerprint) ||
    typeof value.grantScopeFingerprint !== 'string' ||
    !FINGERPRINT.test(value.grantScopeFingerprint) ||
    !OWNER_CALL_OPERATION_PHASES.includes(value.phase as OwnerCallGrantOperationPhase) ||
    !isDate(value.registeredAt) ||
    !isDate(value.reviewExpiresAt) ||
    !isDate(value.grantExpiresAt) ||
    !isNullableDate(value.admittedAt) ||
    !isNullableDate(value.committedAt) ||
    !isNullableDate(value.closedAt) ||
    !isNullableDate(value.rejectedAt) ||
    !isNullableUuid(value.createdPolicyId) ||
    !(
      value.wakeGeneration === null ||
      (typeof value.wakeGeneration === 'number' &&
        Number.isSafeInteger(value.wakeGeneration) &&
        value.wakeGeneration > 0)
    ) ||
    !isDate(value.updatedAt)
  )
    return null;

  const registeredAt = value.registeredAt as Date;
  const reviewExpiresAt = value.reviewExpiresAt as Date;
  const grantExpiresAt = value.grantExpiresAt as Date;
  const admittedAt = value.admittedAt as Date | null;
  const committedAt = value.committedAt as Date | null;
  const closedAt = value.closedAt as Date | null;
  const rejectedAt = value.rejectedAt as Date | null;
  const updatedAt = value.updatedAt as Date;
  const phase = value.phase as OwnerCallGrantOperationPhase;
  if (
    compareExactTimestamps(reviewExpiresAt, registeredAt) <= 0 ||
    compareExactTimestamps(grantExpiresAt, registeredAt) <= 0
  )
    return null;

  if (phase === 'registered') {
    if (
      admittedAt ||
      committedAt ||
      closedAt ||
      rejectedAt ||
      value.createdPolicyId ||
      value.wakeGeneration ||
      compareExactTimestamps(updatedAt, registeredAt) < 0
    )
      return null;
  } else if (phase === 'admitted') {
    if (
      !admittedAt ||
      compareExactTimestamps(admittedAt, registeredAt) < 0 ||
      compareExactTimestamps(admittedAt, reviewExpiresAt) >= 0 ||
      committedAt ||
      closedAt ||
      rejectedAt ||
      value.createdPolicyId ||
      value.wakeGeneration ||
      compareExactTimestamps(updatedAt, admittedAt) < 0
    )
      return null;
  } else if (phase === 'committed') {
    if (
      !admittedAt ||
      compareExactTimestamps(admittedAt, registeredAt) < 0 ||
      compareExactTimestamps(admittedAt, reviewExpiresAt) >= 0 ||
      !committedAt ||
      compareExactTimestamps(committedAt, admittedAt) < 0 ||
      compareExactTimestamps(committedAt, reviewExpiresAt) >= 0 ||
      closedAt ||
      rejectedAt ||
      !value.createdPolicyId ||
      !value.wakeGeneration ||
      compareExactTimestamps(updatedAt, committedAt) < 0
    )
      return null;
  } else if (phase === 'closed_no_effect') {
    if (
      !closedAt ||
      (admittedAt !== null &&
        (compareExactTimestamps(admittedAt, registeredAt) < 0 ||
          compareExactTimestamps(admittedAt, reviewExpiresAt) >= 0)) ||
      compareExactTimestamps(closedAt, admittedAt ?? registeredAt) < 0 ||
      committedAt ||
      rejectedAt ||
      value.createdPolicyId ||
      value.wakeGeneration ||
      compareExactTimestamps(updatedAt, closedAt) < 0
    )
      return null;
  } else if (
    !rejectedAt ||
    (admittedAt !== null &&
      (compareExactTimestamps(admittedAt, registeredAt) < 0 ||
        compareExactTimestamps(admittedAt, reviewExpiresAt) >= 0)) ||
    compareExactTimestamps(rejectedAt, admittedAt ?? registeredAt) < 0 ||
    committedAt ||
    closedAt ||
    value.createdPolicyId ||
    value.wakeGeneration ||
    compareExactTimestamps(updatedAt, rejectedAt) < 0
  ) {
    return null;
  }

  return value as unknown as OwnerCallGrantOperation;
}

/** A current slot must point to the exact receipt generation it names. */
export function ownerCallGrantOperationMatchesSlot(
  slot: OwnerCallGrantOperationSlot,
  operation: OwnerCallGrantOperation,
): boolean {
  return (
    slot.purpose === OWNER_CALL_OPERATION_PURPOSE &&
    slot.schemaVersion === OWNER_CALL_OPERATION_SCHEMA_VERSION &&
    slot.ownerId === operation.ownerId &&
    slot.approvalId === operation.approvalId &&
    slot.generation === operation.slotGeneration &&
    slot.currentGrantId === operation.grantId
  );
}
