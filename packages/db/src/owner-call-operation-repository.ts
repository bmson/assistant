import {
  compareExactTimestamps,
  OWNER_CALL_OPERATION_PURPOSE,
  type OwnerCallGrantOperation,
  type OwnerCallGrantOperationSlot,
  ownerCallGrantOperationMatchesSlot,
  parseOwnerCallGrantOperation,
  parseOwnerCallGrantOperationSlot,
} from '@assistant/persistence';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  decodePostgresOwnerCallTimestamp,
  postgresOwnerCallClock,
  postgresOwnerCallTimestamp,
} from './owner-call-timestamps.js';
import { ownerCallGrantOperationSlots, ownerCallGrantOperations } from './schema.js';

const slotSelection = {
  ...getTableColumns(ownerCallGrantOperationSlots),
  updatedAt: postgresOwnerCallTimestamp(ownerCallGrantOperationSlots.updatedAt),
};
const operationSelection = {
  ...getTableColumns(ownerCallGrantOperations),
  registeredAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.registeredAt),
  reviewExpiresAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.reviewExpiresAt),
  grantExpiresAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.grantExpiresAt),
  admittedAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.admittedAt),
  committedAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.committedAt),
  closedAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.closedAt),
  rejectedAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.rejectedAt),
  updatedAt: postgresOwnerCallTimestamp(ownerCallGrantOperations.updatedAt),
};

type OperationTx = Pick<Db, 'execute' | 'insert' | 'select' | 'update'>;

export interface OwnerCallGrantOperationBinding {
  ownerId: string;
  approvalId: string;
  grantId: string;
  taskId: string;
  toolCallId: string;
  slotGeneration: number;
  requestFingerprint: string;
  grantScopeFingerprint: string;
}

export type OwnerCallGrantOperationConflict =
  | 'slot_generation_changed'
  | 'operation_not_current'
  | 'operation_active'
  | 'operation_not_admitted'
  | 'review_expired'
  | 'grant_expired'
  | 'binding_changed'
  | 'corrupt_or_unavailable';

export type OwnerCallGrantOperationWriteResult =
  | { ok: true; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation }
  | { ok: false; reason: OwnerCallGrantOperationConflict };

type LockedState =
  | { ok: true; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation | null }
  | { ok: false; reason: OwnerCallGrantOperationConflict };

type CurrentCallValidator = (
  tx: OperationTx,
  binding: OwnerCallGrantOperationBinding,
  repositoryNow: Date,
) => Promise<boolean>;
type CloseAuthorityValidator = (
  tx: OperationTx,
  binding: OwnerCallGrantOperationBinding,
) => Promise<boolean>;

export class OwnerCallGrantOperationRollbackError extends Error {
  constructor(readonly reason: OwnerCallGrantOperationConflict) {
    super(reason);
  }
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

async function databaseNow(tx: OperationTx): Promise<Date | null> {
  const [row] = await tx.execute<{ now: Date | string }>(postgresOwnerCallClock);
  return decodePostgresOwnerCallTimestamp(row?.now);
}

/** Lock order is always per-approval slot, current operation, then caller's task/approval/policy reads. */
async function lockCurrentState(
  tx: OperationTx,
  ownerId: string,
  approvalId: string,
  createSlot: boolean,
): Promise<LockedState> {
  if (createSlot) {
    await tx
      .insert(ownerCallGrantOperationSlots)
      .values({
        ownerId,
        approvalId,
        purpose: OWNER_CALL_OPERATION_PURPOSE,
        schemaVersion: 1,
        generation: 0,
        currentGrantId: null,
      })
      .onConflictDoNothing();
  }

  const [rawSlot] = await tx
    .select(slotSelection)
    .from(ownerCallGrantOperationSlots)
    .where(
      and(
        eq(ownerCallGrantOperationSlots.ownerId, ownerId),
        eq(ownerCallGrantOperationSlots.approvalId, approvalId),
      ),
    )
    .for('update')
    .limit(1);
  const slot = parseOwnerCallGrantOperationSlot(rawSlot);
  if (!slot) return { ok: false, reason: 'corrupt_or_unavailable' };
  if (slot.currentGrantId === null) return { ok: true, slot, operation: null };

  const [rawOperation] = await tx
    .select(operationSelection)
    .from(ownerCallGrantOperations)
    .where(
      and(
        eq(ownerCallGrantOperations.ownerId, ownerId),
        eq(ownerCallGrantOperations.approvalId, approvalId),
        eq(ownerCallGrantOperations.grantId, slot.currentGrantId),
      ),
    )
    .for('update')
    .limit(1);
  const operation = parseOwnerCallGrantOperation(rawOperation);
  if (!operation || !ownerCallGrantOperationMatchesSlot(slot, operation))
    return { ok: false, reason: 'corrupt_or_unavailable' };
  return { ok: true, slot, operation };
}

function bindingMatches(
  operation: OwnerCallGrantOperation,
  binding: OwnerCallGrantOperationBinding,
): boolean {
  return (
    operation.ownerId === binding.ownerId &&
    operation.approvalId === binding.approvalId &&
    operation.grantId === binding.grantId &&
    operation.taskId === binding.taskId &&
    operation.toolCallId === binding.toolCallId &&
    operation.slotGeneration === binding.slotGeneration &&
    operation.requestFingerprint === binding.requestFingerprint &&
    operation.grantScopeFingerprint === binding.grantScopeFingerprint
  );
}

export type OwnerCallGrantOperationDiscovery =
  | { kind: 'empty'; generation: 0 }
  | { kind: 'current'; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation }
  | { kind: 'unavailable' };

/** Read the exact current slot and pointed receipt with one bounded joined query. */
export async function discoverOwnerCallGrantOperation(
  db: Db,
  ownerId: string,
  approvalId: string,
): Promise<OwnerCallGrantOperationDiscovery> {
  return discoverOwnerCallGrantOperationInTransaction(db, ownerId, approvalId);
}

export async function discoverOwnerCallGrantOperationInTransaction(
  db: Pick<Db, 'select'>,
  ownerId: string,
  approvalId: string,
): Promise<OwnerCallGrantOperationDiscovery> {
  if (!validUuid(ownerId) || !validUuid(approvalId)) return { kind: 'unavailable' };
  const [row] = await db
    .select({ slot: slotSelection, operation: operationSelection })
    .from(ownerCallGrantOperationSlots)
    .leftJoin(
      ownerCallGrantOperations,
      and(
        eq(ownerCallGrantOperations.ownerId, ownerCallGrantOperationSlots.ownerId),
        eq(ownerCallGrantOperations.approvalId, ownerCallGrantOperationSlots.approvalId),
        eq(ownerCallGrantOperations.grantId, ownerCallGrantOperationSlots.currentGrantId),
        eq(ownerCallGrantOperations.slotGeneration, ownerCallGrantOperationSlots.generation),
      ),
    )
    .where(
      and(
        eq(ownerCallGrantOperationSlots.ownerId, ownerId),
        eq(ownerCallGrantOperationSlots.approvalId, approvalId),
      ),
    )
    .limit(1);
  if (!row) return { kind: 'empty', generation: 0 };
  const slot = parseOwnerCallGrantOperationSlot(row.slot);
  const operation = parseOwnerCallGrantOperation(row.operation);
  if (
    !slot ||
    !operation ||
    slot.ownerId !== ownerId ||
    slot.approvalId !== approvalId ||
    !ownerCallGrantOperationMatchesSlot(slot, operation)
  )
    return { kind: 'unavailable' };
  return { kind: 'current', slot, operation };
}

function validBinding(binding: OwnerCallGrantOperationBinding): boolean {
  return (
    validUuid(binding.ownerId) &&
    validUuid(binding.approvalId) &&
    validUuid(binding.grantId) &&
    validUuid(binding.taskId) &&
    validUuid(binding.toolCallId) &&
    Number.isSafeInteger(binding.slotGeneration) &&
    binding.slotGeneration > 0 &&
    validFingerprint(binding.requestFingerprint) &&
    validFingerprint(binding.grantScopeFingerprint)
  );
}

/** Explicit REGISTER: creates a slot sentinel if absent, then CAS-registers one operation. */
export async function registerOwnerCallGrantOperation(
  db: Db,
  input: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    taskId: string;
    toolCallId: string;
    expectedSlotGeneration: number;
    requestFingerprint: string;
    grantScopeFingerprint: string;
    reviewExpiresAt: Date;
    grantExpiresAt: Date;
    replaceUnadmittedRegistration: boolean;
    validateCurrentCall: CurrentCallValidator;
  },
): Promise<OwnerCallGrantOperationWriteResult> {
  const reviewExpiresAt = decodePostgresOwnerCallTimestamp(input.reviewExpiresAt);
  const grantExpiresAt = decodePostgresOwnerCallTimestamp(input.grantExpiresAt);
  if (
    !validUuid(input.ownerId) ||
    !validUuid(input.approvalId) ||
    !validUuid(input.grantId) ||
    !validUuid(input.taskId) ||
    !validUuid(input.toolCallId) ||
    !Number.isSafeInteger(input.expectedSlotGeneration) ||
    input.expectedSlotGeneration < 0 ||
    !validFingerprint(input.requestFingerprint) ||
    !validFingerprint(input.grantScopeFingerprint) ||
    !reviewExpiresAt ||
    !grantExpiresAt
  )
    return { ok: false, reason: 'corrupt_or_unavailable' };

  try {
    return await db.transaction(async (tx) => {
      const locked = await lockCurrentState(tx, input.ownerId, input.approvalId, true);
      if (!locked.ok) return locked;
      if (locked.slot.generation !== input.expectedSlotGeneration)
        return { ok: false, reason: 'slot_generation_changed' };
      if (locked.slot.generation >= 2_147_483_647)
        return { ok: false, reason: 'corrupt_or_unavailable' };
      const binding: OwnerCallGrantOperationBinding = {
        ownerId: input.ownerId,
        approvalId: input.approvalId,
        grantId: input.grantId,
        taskId: input.taskId,
        toolCallId: input.toolCallId,
        slotGeneration: locked.slot.generation + 1,
        requestFingerprint: input.requestFingerprint,
        grantScopeFingerprint: input.grantScopeFingerprint,
      };
      const validationNow = await databaseNow(tx);
      if (!validationNow) return { ok: false, reason: 'corrupt_or_unavailable' };
      if (!(await input.validateCurrentCall(tx, binding, validationNow)))
        return { ok: false, reason: 'binding_changed' };
      const now = await databaseNow(tx);
      if (!now) return { ok: false, reason: 'corrupt_or_unavailable' };
      if (
        compareExactTimestamps(reviewExpiresAt, now) <= 0 ||
        compareExactTimestamps(grantExpiresAt, now) <= 0
      )
        return { ok: false, reason: 'binding_changed' };

      if (locked.operation) {
        const phase = locked.operation.phase;
        const canReplace = phase === 'registered' && input.replaceUnadmittedRegistration;
        if (phase === 'admitted' || (phase === 'registered' && !canReplace))
          return { ok: false, reason: 'operation_active' };
        if (phase === 'registered' && canReplace) {
          await tx
            .update(ownerCallGrantOperations)
            .set({ phase: 'closed_no_effect', closedAt: now, updatedAt: now })
            .where(
              and(
                eq(ownerCallGrantOperations.ownerId, input.ownerId),
                eq(ownerCallGrantOperations.approvalId, input.approvalId),
                eq(ownerCallGrantOperations.grantId, locked.operation.grantId),
                eq(ownerCallGrantOperations.phase, 'registered'),
              ),
            );
        }
      }

      const operationInput = {
        purpose: OWNER_CALL_OPERATION_PURPOSE,
        schemaVersion: 1 as const,
        operationVersion: 1 as const,
        ...binding,
        phase: 'registered' as const,
        registeredAt: now,
        reviewExpiresAt,
        grantExpiresAt,
        admittedAt: null,
        committedAt: null,
        closedAt: null,
        rejectedAt: null,
        createdPolicyId: null,
        wakeGeneration: null,
        updatedAt: now,
      };
      const [inserted] = await tx
        .insert(ownerCallGrantOperations)
        .values(operationInput)
        .onConflictDoNothing()
        .returning(operationSelection);
      const operation = parseOwnerCallGrantOperation(inserted);
      if (!operation) throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
      const [updatedSlot] = await tx
        .update(ownerCallGrantOperationSlots)
        .set({
          generation: operation.slotGeneration,
          currentGrantId: operation.grantId,
          updatedAt: now,
        })
        .where(
          and(
            eq(ownerCallGrantOperationSlots.ownerId, input.ownerId),
            eq(ownerCallGrantOperationSlots.approvalId, input.approvalId),
            eq(ownerCallGrantOperationSlots.generation, input.expectedSlotGeneration),
          ),
        )
        .returning(slotSelection);
      const slot = parseOwnerCallGrantOperationSlot(updatedSlot);
      if (!slot || !ownerCallGrantOperationMatchesSlot(slot, operation))
        throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
      return { ok: true, slot, operation };
    });
  } catch (error) {
    if (error instanceof OwnerCallGrantOperationRollbackError)
      return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Explicit ADMIT is a separate transaction and can never synthesize a missing receipt. */
export async function admitOwnerCallGrantOperation(
  db: Db,
  binding: OwnerCallGrantOperationBinding & { validateCurrentCall: CurrentCallValidator },
): Promise<OwnerCallGrantOperationWriteResult> {
  if (!validBinding(binding)) return { ok: false, reason: 'corrupt_or_unavailable' };
  return db.transaction(async (tx) => {
    const locked = await lockCurrentState(tx, binding.ownerId, binding.approvalId, false);
    if (!locked.ok) return locked;
    if (
      !locked.operation ||
      !ownerCallGrantOperationMatchesSlot(locked.slot, locked.operation) ||
      !bindingMatches(locked.operation, binding)
    )
      return { ok: false, reason: 'operation_not_current' };
    if (locked.operation.phase !== 'registered')
      return { ok: false, reason: 'operation_not_admitted' };
    const validationNow = await databaseNow(tx);
    if (!validationNow) return { ok: false, reason: 'corrupt_or_unavailable' };
    if (!(await binding.validateCurrentCall(tx, binding, validationNow)))
      return { ok: false, reason: 'binding_changed' };
    const now = await databaseNow(tx);
    if (!now) return { ok: false, reason: 'corrupt_or_unavailable' };
    if (compareExactTimestamps(locked.operation.reviewExpiresAt, now) <= 0)
      return { ok: false, reason: 'review_expired' };
    const [row] = await tx
      .update(ownerCallGrantOperations)
      .set({ phase: 'admitted', admittedAt: now, updatedAt: now })
      .where(
        and(
          eq(ownerCallGrantOperations.ownerId, binding.ownerId),
          eq(ownerCallGrantOperations.approvalId, binding.approvalId),
          eq(ownerCallGrantOperations.grantId, binding.grantId),
          eq(ownerCallGrantOperations.phase, 'registered'),
        ),
      )
      .returning(operationSelection);
    const operation = parseOwnerCallGrantOperation(row);
    if (!operation) throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
    return { ok: true, slot: locked.slot, operation };
  });
}

/** One coherent point lookup of a caller-specified historical or current grant receipt. */
export async function readOwnerCallGrantOperationCheck(
  db: Db,
  ownerId: string,
  approvalId: string,
  expectedGrantId: string,
): Promise<
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | {
      status: 'available';
      isCurrent: boolean;
      slot: OwnerCallGrantOperationSlot;
      operation: OwnerCallGrantOperation;
    }
> {
  if (!validUuid(ownerId) || !validUuid(approvalId) || !validUuid(expectedGrantId))
    return { status: 'unavailable' };
  const [row] = await db
    .select({ slot: slotSelection, operation: operationSelection })
    .from(ownerCallGrantOperations)
    .leftJoin(
      ownerCallGrantOperationSlots,
      and(
        eq(ownerCallGrantOperationSlots.ownerId, ownerCallGrantOperations.ownerId),
        eq(ownerCallGrantOperationSlots.approvalId, ownerCallGrantOperations.approvalId),
      ),
    )
    .where(
      and(
        eq(ownerCallGrantOperations.ownerId, ownerId),
        eq(ownerCallGrantOperations.approvalId, approvalId),
        eq(ownerCallGrantOperations.grantId, expectedGrantId),
      ),
    )
    .limit(1);
  if (!row?.operation) return { status: 'not_found' };
  if (!row.slot) return { status: 'unavailable' };
  const slot = parseOwnerCallGrantOperationSlot(row.slot);
  const operation = parseOwnerCallGrantOperation(row.operation);
  if (
    !slot ||
    !operation ||
    slot.ownerId !== ownerId ||
    slot.approvalId !== approvalId ||
    operation.ownerId !== ownerId ||
    operation.approvalId !== approvalId ||
    operation.grantId !== expectedGrantId ||
    operation.slotGeneration > slot.generation
  )
    return { status: 'unavailable' };
  const isCurrent = operation.slotGeneration === slot.generation;
  if (isCurrent && !ownerCallGrantOperationMatchesSlot(slot, operation))
    return { status: 'unavailable' };
  if (!isCurrent && (slot.currentGrantId === null || slot.currentGrantId === expectedGrantId))
    return { status: 'unavailable' };
  return { status: 'available', isCurrent, slot, operation };
}

/** Explicit CLOSE competes on slot then operation; caller must verify capability/confirmation first. */
export async function closeOwnerCallGrantOperation(
  db: Db,
  binding: OwnerCallGrantOperationBinding & {
    validateCloseAuthority: CloseAuthorityValidator;
  },
): Promise<OwnerCallGrantOperationWriteResult> {
  if (!validBinding(binding)) return { ok: false, reason: 'corrupt_or_unavailable' };
  return db.transaction(async (tx) => {
    const locked = await lockCurrentState(tx, binding.ownerId, binding.approvalId, false);
    if (!locked.ok) return locked;
    if (!locked.operation || !bindingMatches(locked.operation, binding))
      return { ok: false, reason: 'operation_not_current' };
    if (!(await binding.validateCloseAuthority(tx, binding)))
      return { ok: false, reason: 'binding_changed' };
    if (locked.operation.phase === 'committed')
      return { ok: true, slot: locked.slot, operation: locked.operation };
    if (
      locked.operation.phase === 'closed_no_effect' ||
      locked.operation.phase === 'rejected_no_effect'
    )
      return { ok: true, slot: locked.slot, operation: locked.operation };
    const now = await databaseNow(tx);
    if (!now) return { ok: false, reason: 'corrupt_or_unavailable' };
    const [row] = await tx
      .update(ownerCallGrantOperations)
      .set({ phase: 'closed_no_effect', closedAt: now, updatedAt: now })
      .where(
        and(
          eq(ownerCallGrantOperations.ownerId, binding.ownerId),
          eq(ownerCallGrantOperations.approvalId, binding.approvalId),
          eq(ownerCallGrantOperations.grantId, binding.grantId),
          eq(ownerCallGrantOperations.phase, locked.operation.phase),
        ),
      )
      .returning(operationSelection);
    const operation = parseOwnerCallGrantOperation(row);
    if (!operation) throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
    return { ok: true, slot: locked.slot, operation };
  });
}

/** Acquire first in an existing FINALIZE transaction, before task/approval/policy locks. */
export async function lockOwnerCallGrantOperationForFinalize(
  tx: OperationTx,
  binding: OwnerCallGrantOperationBinding,
): Promise<
  | { ok: true; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation }
  | { ok: false; reason: OwnerCallGrantOperationConflict }
> {
  if (!validBinding(binding)) return { ok: false, reason: 'corrupt_or_unavailable' };
  const locked = await lockCurrentState(tx, binding.ownerId, binding.approvalId, false);
  if (!locked.ok) return locked;
  if (!locked.operation || !bindingMatches(locked.operation, binding))
    return { ok: false, reason: 'operation_not_current' };
  if (locked.operation.phase !== 'admitted') return { ok: false, reason: 'operation_not_admitted' };
  return { ok: true, slot: locked.slot, operation: locked.operation };
}

/** Complete the locked operation in the caller's existing approval transaction. */
export async function commitOwnerCallGrantOperationInTransaction(
  tx: OperationTx,
  locked: { slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation },
  result: { createdPolicyId: string; wakeGeneration: number },
): Promise<OwnerCallGrantOperation> {
  const now = await databaseNow(tx);
  if (!now) throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
  if (
    !validUuid(result.createdPolicyId) ||
    !Number.isSafeInteger(result.wakeGeneration) ||
    result.wakeGeneration < 1 ||
    locked.operation.phase !== 'admitted' ||
    !ownerCallGrantOperationMatchesSlot(locked.slot, locked.operation)
  )
    throw new OwnerCallGrantOperationRollbackError('operation_not_admitted');
  if (compareExactTimestamps(now, locked.operation.reviewExpiresAt) >= 0)
    throw new OwnerCallGrantOperationRollbackError('review_expired');
  if (compareExactTimestamps(now, locked.operation.grantExpiresAt) >= 0)
    throw new OwnerCallGrantOperationRollbackError('grant_expired');
  const [row] = await tx
    .update(ownerCallGrantOperations)
    .set({
      phase: 'committed',
      committedAt: now,
      createdPolicyId: result.createdPolicyId,
      wakeGeneration: result.wakeGeneration,
      updatedAt: now,
    })
    .where(
      and(
        eq(ownerCallGrantOperations.ownerId, locked.operation.ownerId),
        eq(ownerCallGrantOperations.approvalId, locked.operation.approvalId),
        eq(ownerCallGrantOperations.grantId, locked.operation.grantId),
        eq(ownerCallGrantOperations.phase, 'admitted'),
      ),
    )
    .returning(operationSelection);
  const operation = parseOwnerCallGrantOperation(row);
  if (!operation || operation.phase !== 'committed')
    throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
  return operation;
}

/** Only a conclusive non-applying outcome may close an admitted operation as rejected. */
export async function rejectOwnerCallGrantOperationInTransaction(
  tx: OperationTx,
  locked: { slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation },
): Promise<OwnerCallGrantOperation> {
  const now = await databaseNow(tx);
  if (
    !now ||
    locked.operation.phase !== 'admitted' ||
    !ownerCallGrantOperationMatchesSlot(locked.slot, locked.operation)
  )
    throw new OwnerCallGrantOperationRollbackError('operation_not_admitted');
  const [row] = await tx
    .update(ownerCallGrantOperations)
    .set({ phase: 'rejected_no_effect', rejectedAt: now, updatedAt: now })
    .where(
      and(
        eq(ownerCallGrantOperations.ownerId, locked.operation.ownerId),
        eq(ownerCallGrantOperations.approvalId, locked.operation.approvalId),
        eq(ownerCallGrantOperations.grantId, locked.operation.grantId),
        eq(ownerCallGrantOperations.phase, 'admitted'),
      ),
    )
    .returning(operationSelection);
  const operation = parseOwnerCallGrantOperation(row);
  if (!operation || operation.phase !== 'rejected_no_effect')
    throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
  return operation;
}
