import { createHash } from 'node:crypto';
import {
  compareExactTimestamps,
  isValidExactTimestamp,
  type OwnerCallGrantOperation,
  type OwnerCallGrantOperationSlot,
  ownerCallGrantOperationMatchesSlot,
  parseOwnerCallGrantOperation,
  parseOwnerCallGrantOperationSlot,
  parsePhoneCallOwnerActionGrantMatch,
  parsePhoneCallToOwnerNumberGrantMatch,
  phoneCallOwnerActionGrantIsLive,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberGrantScopeFingerprint,
  phoneCallToOwnerNumberGrantIsLive,
} from '@assistant/persistence';
import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { decodeOwnerCallRecord, encodeOwnerCallRecord } from './owner-call-timestamps.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX256 = /^[a-f0-9]{64}$/;
const SLOT_COLLECTION = 'ownerCallGrantOperationSlots';
const OPERATION_COLLECTION = 'ownerCallGrantOperations';

type ReadResult =
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | {
      kind: 'current';
      slotRef: DocumentReference;
      slot: OwnerCallGrantOperationSlot;
      operationRef: DocumentReference;
      operation: OwnerCallGrantOperation;
    };

function tupleKey(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function slotRef(store: InstallationStore, ownerId: string, approvalId: string): DocumentReference {
  return store.doc(SLOT_COLLECTION, tupleKey(['owner-call-grant-slot-v1', ownerId, approvalId]));
}

function operationRef(
  store: InstallationStore,
  ownerId: string,
  approvalId: string,
  grantId: string,
): DocumentReference {
  return store.doc(
    OPERATION_COLLECTION,
    tupleKey(['owner-call-grant-operation-v1', ownerId, approvalId, grantId]),
  );
}

function validScope(ownerId: string, approvalId: string): boolean {
  return UUID.test(ownerId) && UUID.test(approvalId);
}

function readSlot(snapshot: {
  id: string;
  exists: boolean;
  data(): unknown;
}): OwnerCallGrantOperationSlot | null {
  if (!snapshot.exists) return null;
  const value = parseOwnerCallGrantOperationSlot(decodeOwnerCallRecord(snapshot.data()));
  if (!value) return null;
  try {
    return documentKey(tupleKey(['owner-call-grant-slot-v1', value.ownerId, value.approvalId])) ===
      snapshot.id
      ? value
      : null;
  } catch {
    return null;
  }
}

function readOperation(snapshot: {
  id: string;
  exists: boolean;
  data(): unknown;
}): OwnerCallGrantOperation | null {
  if (!snapshot.exists) return null;
  const value = parseOwnerCallGrantOperation(decodeOwnerCallRecord(snapshot.data()));
  if (!value) return null;
  try {
    return documentKey(
      tupleKey(['owner-call-grant-operation-v1', value.ownerId, value.approvalId, value.grantId]),
    ) === snapshot.id
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Read only the slot and its one pointed operation. Dangling or malformed state is unavailable, not absent. */
async function readCurrentInTransaction(
  tx: Transaction,
  store: InstallationStore,
  ownerId: string,
  approvalId: string,
): Promise<ReadResult> {
  if (!validScope(ownerId, approvalId)) return { kind: 'unavailable' };
  const pointer = slotRef(store, ownerId, approvalId);
  const pointerSnapshot = await tx.get(pointer);
  if (!pointerSnapshot.exists) return { kind: 'empty' };
  const slot = readSlot(pointerSnapshot);
  if (!slot || slot.ownerId !== ownerId || slot.approvalId !== approvalId || !slot.currentGrantId)
    return { kind: 'unavailable' };
  const receipt = operationRef(store, ownerId, approvalId, slot.currentGrantId);
  const operationSnapshot = await tx.get(receipt);
  const operation = readOperation(operationSnapshot);
  if (
    !operation ||
    operation.ownerId !== ownerId ||
    operation.approvalId !== approvalId ||
    !ownerCallGrantOperationMatchesSlot(slot, operation)
  )
    return { kind: 'unavailable' };
  return { kind: 'current', slotRef: pointer, slot, operationRef: receipt, operation };
}

export type OwnerCallGrantOperationDiscovery =
  | { kind: 'empty'; generation: 0 }
  | { kind: 'current'; slot: OwnerCallGrantOperationSlot; operation: OwnerCallGrantOperation }
  | { kind: 'unavailable' };

/** Discover the current operation without scanning; a dangling or malformed pointer is unavailable. */
export async function discoverOwnerCallGrantOperation(
  store: InstallationStore,
  ownerId: string,
  approvalId: string,
): Promise<OwnerCallGrantOperationDiscovery> {
  if (!validScope(ownerId, approvalId)) return { kind: 'unavailable' };
  try {
    return await store.db.runTransaction((tx) =>
      discoverOwnerCallGrantOperationInTransaction(tx, store, ownerId, approvalId),
    );
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function discoverOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  ownerId: string,
  approvalId: string,
): Promise<OwnerCallGrantOperationDiscovery> {
  if (!validScope(ownerId, approvalId)) return { kind: 'unavailable' };
  const pointer = slotRef(store, ownerId, approvalId);
  const pointerSnapshot = await tx.get(pointer);
  if (!pointerSnapshot.exists) return { kind: 'empty', generation: 0 };
  const slot = readSlot(pointerSnapshot);
  if (!slot || slot.ownerId !== ownerId || slot.approvalId !== approvalId || !slot.currentGrantId)
    return { kind: 'unavailable' };
  const receiptRef = operationRef(store, ownerId, approvalId, slot.currentGrantId);
  const receiptSnapshot = await tx.get(receiptRef);
  const operation = readOperation(receiptSnapshot);
  if (
    !operation ||
    operation.ownerId !== ownerId ||
    operation.approvalId !== approvalId ||
    !ownerCallGrantOperationMatchesSlot(slot, operation)
  )
    return { kind: 'unavailable' };
  return { kind: 'current', slot, operation };
}

export interface OwnerCallOperationRegistration {
  /** Server-minted operation ID; never copied from a client review token. */
  grantId: string;
  ownerId: string;
  approvalId: string;
  taskId: string;
  toolCallId: string;
  expectedGeneration: number;
  requestFingerprint: string;
  grantScopeFingerprint: string;
  reviewExpiresAt: Date;
  grantExpiresAt: Date;
  replaceUnadmittedRegistration?: boolean;
}

export type OwnerCallOperationRegistrationResult =
  | { kind: 'registered'; operation: OwnerCallGrantOperation }
  | { kind: 'busy' | 'conflict' | 'unavailable' };

/**
 * Private storage transition. The trusted server adapter must first read and validate the current
 * approval/task/tool/source/scope/policy context in this SAME transaction, before calling this
 * helper. This helper then performs only metadata reads and writes. It does not authorize a grant.
 */
export async function registerOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  input: OwnerCallOperationRegistration,
  validateCurrentCall: (tx: Transaction) => Promise<boolean>,
): Promise<OwnerCallOperationRegistrationResult> {
  if (
    !validScope(input.ownerId, input.approvalId) ||
    !UUID.test(input.grantId) ||
    !UUID.test(input.taskId) ||
    !UUID.test(input.toolCallId) ||
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 0 ||
    !HEX256.test(input.requestFingerprint) ||
    !HEX256.test(input.grantScopeFingerprint) ||
    !isValidExactTimestamp(input.reviewExpiresAt) ||
    !isValidExactTimestamp(input.grantExpiresAt)
  )
    return { kind: 'unavailable' };

  // Callback must be read-only; all business validation reads precede protocol reads and every write.
  if (!(await validateCurrentCall(tx))) return { kind: 'conflict' };
  const pointer = slotRef(store, input.ownerId, input.approvalId);
  const pointerSnapshot = await tx.get(pointer);
  const existingSlot = pointerSnapshot.exists ? readSlot(pointerSnapshot) : null;
  if (pointerSnapshot.exists && !existingSlot) return { kind: 'unavailable' };
  const generation = existingSlot?.generation ?? 0;
  if (generation !== input.expectedGeneration || generation >= Number.MAX_SAFE_INTEGER - 1)
    return { kind: 'conflict' };

  let priorRef: DocumentReference | null = null;
  let prior: OwnerCallGrantOperation | null = null;
  if (existingSlot?.currentGrantId) {
    priorRef = operationRef(store, input.ownerId, input.approvalId, existingSlot.currentGrantId);
    const priorSnapshot = await tx.get(priorRef);
    prior = readOperation(priorSnapshot);
    if (
      !prior ||
      !ownerCallGrantOperationMatchesSlot(existingSlot, prior) ||
      prior.ownerId !== input.ownerId ||
      prior.approvalId !== input.approvalId
    )
      return { kind: 'unavailable' };
    if (prior.phase === 'admitted') return { kind: 'busy' };
    if (
      prior.phase !== 'registered' &&
      prior.phase !== 'committed' &&
      prior.phase !== 'closed_no_effect' &&
      prior.phase !== 'rejected_no_effect'
    )
      return { kind: 'unavailable' };
    if (prior.phase === 'registered' && input.replaceUnadmittedRegistration !== true)
      return { kind: 'conflict' };
  }

  const nextGeneration = generation + 1;
  const nextRef = operationRef(store, input.ownerId, input.approvalId, input.grantId);
  const nextSnapshot = await tx.get(nextRef);
  if (nextSnapshot.exists) return { kind: 'conflict' };
  const registeredAt = store.now();
  if (
    !isValidExactTimestamp(registeredAt) ||
    compareExactTimestamps(input.reviewExpiresAt, registeredAt) <= 0 ||
    compareExactTimestamps(input.grantExpiresAt, registeredAt) <= 0
  )
    return { kind: 'conflict' };
  const operation: OwnerCallGrantOperation = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    operationVersion: 1,
    ownerId: input.ownerId,
    approvalId: input.approvalId,
    grantId: input.grantId,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
    slotGeneration: nextGeneration,
    requestFingerprint: input.requestFingerprint,
    grantScopeFingerprint: input.grantScopeFingerprint,
    phase: 'registered',
    registeredAt,
    reviewExpiresAt: input.reviewExpiresAt,
    grantExpiresAt: input.grantExpiresAt,
    admittedAt: null,
    committedAt: null,
    closedAt: null,
    rejectedAt: null,
    createdPolicyId: null,
    wakeGeneration: null,
    updatedAt: registeredAt,
  };
  if (!parseOwnerCallGrantOperation(operation)) return { kind: 'unavailable' };
  const nextSlot: OwnerCallGrantOperationSlot = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    ownerId: input.ownerId,
    approvalId: input.approvalId,
    generation: nextGeneration,
    currentGrantId: input.grantId,
    updatedAt: registeredAt,
  };
  if (!parseOwnerCallGrantOperationSlot(nextSlot)) return { kind: 'unavailable' };

  // No writes occur until all reads above have completed. A replaceable unadmitted registration is
  // permanently closed in the same transaction as pointer advance; admitted work is never replaced.
  if (prior?.phase === 'registered' && priorRef && input.replaceUnadmittedRegistration === true) {
    tx.update(
      priorRef,
      encodeOwnerCallRecord({
        ...prior,
        phase: 'closed_no_effect',
        closedAt: registeredAt,
        updatedAt: registeredAt,
      }),
    );
  }
  tx.create(nextRef, encodeOwnerCallRecord({ ...operation }));
  if (pointerSnapshot.exists) tx.update(pointer, encodeOwnerCallRecord({ ...nextSlot }));
  else tx.create(pointer, encodeOwnerCallRecord({ ...nextSlot }));
  return { kind: 'registered', operation };
}

/** Owns the short REGISTER transaction; callers cannot supply a transaction or bypass its CAS. */
export function registerOwnerCallGrantOperation(
  store: InstallationStore,
  input: OwnerCallOperationRegistration,
  validateCurrentCall: (tx: Transaction) => Promise<boolean>,
): Promise<OwnerCallOperationRegistrationResult> {
  return store.db.runTransaction((tx) =>
    registerOwnerCallGrantOperationInTransaction(tx, store, input, validateCurrentCall),
  );
}

export type OwnerCallOperationAdmissionResult =
  | {
      kind: 'admitted';
      operation: OwnerCallGrantOperation;
      operationRef: DocumentReference;
      slotRef: DocumentReference;
    }
  | { kind: 'conflict' | 'unavailable' };

/** Admission callback re-reads/validates all live approval, consent, policy, source, and deadline fences. */
export async function admitOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  expected: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    taskId: string;
    toolCallId: string;
    requestFingerprint: string;
    grantScopeFingerprint: string;
  },
  validateCurrentCall: (tx: Transaction) => Promise<boolean>,
): Promise<OwnerCallOperationAdmissionResult> {
  if (
    !validScope(expected.ownerId, expected.approvalId) ||
    !UUID.test(expected.grantId) ||
    !UUID.test(expected.taskId) ||
    !UUID.test(expected.toolCallId) ||
    !HEX256.test(expected.requestFingerprint) ||
    !HEX256.test(expected.grantScopeFingerprint)
  )
    return { kind: 'unavailable' };
  // Current business fences are re-read in this transaction; sample the clock only after them and
  // after slot/receipt reads so a held transaction cannot admit across the original deadline.
  if (!(await validateCurrentCall(tx))) return { kind: 'conflict' };
  const current = await readCurrentInTransaction(tx, store, expected.ownerId, expected.approvalId);
  if (current.kind !== 'current') return { kind: 'unavailable' };
  const now = store.now();
  if (!isValidExactTimestamp(now)) return { kind: 'unavailable' };
  const op = current.operation;
  if (
    op.grantId !== expected.grantId ||
    op.taskId !== expected.taskId ||
    op.toolCallId !== expected.toolCallId ||
    op.requestFingerprint !== expected.requestFingerprint ||
    op.grantScopeFingerprint !== expected.grantScopeFingerprint ||
    op.phase !== 'registered' ||
    compareExactTimestamps(op.reviewExpiresAt, now) <= 0 ||
    compareExactTimestamps(op.grantExpiresAt, now) <= 0
  )
    return { kind: 'conflict' };
  const admitted: OwnerCallGrantOperation = {
    ...op,
    phase: 'admitted',
    admittedAt: now,
    updatedAt: now,
  };
  if (!parseOwnerCallGrantOperation(admitted)) return { kind: 'unavailable' };
  tx.update(current.operationRef, encodeOwnerCallRecord({ ...admitted }));
  return {
    kind: 'admitted',
    operation: admitted,
    operationRef: current.operationRef,
    slotRef: current.slotRef,
  };
}

/** Owns the short ADMIT transaction; validation callback must perform read-only live fence checks. */
export function admitOwnerCallGrantOperation(
  store: InstallationStore,
  expected: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    taskId: string;
    toolCallId: string;
    requestFingerprint: string;
    grantScopeFingerprint: string;
  },
  validateCurrentCall: (tx: Transaction) => Promise<boolean>,
): Promise<OwnerCallOperationAdmissionResult> {
  return store.db.runTransaction((tx) =>
    admitOwnerCallGrantOperationInTransaction(tx, store, expected, validateCurrentCall),
  );
}

export type OwnerCallGrantPolicyAvailability =
  | 'enabled'
  | 'paused'
  | 'expired'
  | 'changed'
  | 'missing'
  | 'not_applicable';
export type OwnerCallOperationStatus =
  | { kind: 'unavailable' }
  | {
      kind: 'status';
      operation: OwnerCallGrantOperation;
      relation: 'current' | 'historical';
      approvalStatus: string;
      policyAvailability: OwnerCallGrantPolicyAvailability;
      checkedAt: Date;
    };

/** Exact historical lookup: reads approval, task, tool, slot, requested receipt, optional policy (<=6 point docs). */
export async function readOwnerCallGrantOperationStatus(
  store: InstallationStore,
  input: { ownerId: string; approvalId: string; grantId: string },
): Promise<OwnerCallOperationStatus> {
  if (!validScope(input.ownerId, input.approvalId) || !UUID.test(input.grantId))
    return { kind: 'unavailable' };
  try {
    return await store.db.runTransaction(async (tx) => {
      const approvalSnapshot = await tx.get(store.doc('approvals', input.approvalId));
      if (!approvalSnapshot.exists) return { kind: 'unavailable' };
      const approval = decodeRecord<{
        id: string;
        taskId: string;
        toolCallId: string;
        status: string;
      }>(approvalSnapshot.data());
      if (
        approval.id !== input.approvalId ||
        !UUID.test(approval.taskId) ||
        !UUID.test(approval.toolCallId) ||
        !['pending', 'approved', 'denied', 'expired'].includes(approval.status)
      )
        return { kind: 'unavailable' };
      const [taskSnapshot, toolSnapshot] = await tx.getAll(
        store.doc('tasks', approval.taskId),
        store.doc('toolCalls', approval.toolCallId),
      );
      if (!taskSnapshot?.exists || !toolSnapshot?.exists) return { kind: 'unavailable' };
      const task = decodeRecord<{ id: string; agentId: string }>(taskSnapshot.data());
      const tool = decodeRecord<{ id: string; taskId: string }>(toolSnapshot.data());
      if (
        task.id !== approval.taskId ||
        task.agentId !== input.ownerId ||
        tool.id !== approval.toolCallId ||
        tool.taskId !== approval.taskId
      )
        return { kind: 'unavailable' };
      const pointerRef = slotRef(store, input.ownerId, input.approvalId);
      const pointerSnapshot = await tx.get(pointerRef);
      const slot = readSlot(pointerSnapshot);
      if (
        !slot ||
        slot.ownerId !== input.ownerId ||
        slot.approvalId !== input.approvalId ||
        !slot.currentGrantId
      )
        return { kind: 'unavailable' };
      const receiptRef = operationRef(store, input.ownerId, input.approvalId, input.grantId);
      const operationSnapshot = await tx.get(receiptRef);
      const operation = readOperation(operationSnapshot);
      if (
        !operation ||
        operation.grantId !== input.grantId ||
        operation.ownerId !== input.ownerId ||
        operation.approvalId !== input.approvalId ||
        operation.taskId !== approval.taskId ||
        operation.toolCallId !== approval.toolCallId ||
        operation.slotGeneration > slot.generation
      )
        return { kind: 'unavailable' };
      const isCurrent =
        slot.currentGrantId === operation.grantId && slot.generation === operation.slotGeneration;
      if (!isCurrent && operation.slotGeneration >= slot.generation) return { kind: 'unavailable' };
      let policyAvailability: OwnerCallGrantPolicyAvailability = 'not_applicable';
      if (operation.phase === 'committed' && operation.createdPolicyId) {
        const policySnapshot = await tx.get(
          store.doc('approvalPolicies', operation.createdPolicyId),
        );
        if (!policySnapshot.exists) policyAvailability = 'missing';
        else {
          const policy = decodeRecord<{
            id: string;
            agentId: string;
            toolName: string;
            templateKey: string;
            effect: string;
            enabled: boolean;
            match: unknown;
          }>(policySnapshot.data());
          const isV1 = policy.templateKey === 'phone.call.to_owner_number.v1';
          const isV2 = policy.templateKey === 'phone.call.owner_action.v2';
          const legacyMatch = isV1 ? parsePhoneCallToOwnerNumberGrantMatch(policy.match) : null;
          const actionMatch = isV2 ? parsePhoneCallOwnerActionGrantMatch(policy.match) : null;
          const scopeFingerprint = isV1
            ? phoneCallOwnerNumberGrantScopeFingerprint(policy.match)
            : isV2
              ? phoneCallOwnerActionGrantScopeFingerprint(policy.match)
              : null;
          const recognizedMatch = legacyMatch ?? actionMatch;
          if (
            policy.id !== operation.createdPolicyId ||
            policy.agentId !== input.ownerId ||
            policy.toolName !== 'phone.call' ||
            (!isV1 && !isV2) ||
            policy.effect !== 'allow' ||
            !scopeFingerprint ||
            scopeFingerprint !== operation.grantScopeFingerprint ||
            !recognizedMatch
          ) {
            policyAvailability = 'changed';
          } else {
            const checkedAt = store.now();
            if (!isValidExactTimestamp(checkedAt)) return { kind: 'unavailable' };
            const live = legacyMatch
              ? phoneCallToOwnerNumberGrantIsLive(legacyMatch, checkedAt)
              : actionMatch
                ? phoneCallOwnerActionGrantIsLive(actionMatch, checkedAt)
                : false;
            policyAvailability = !live ? 'expired' : policy.enabled ? 'enabled' : 'paused';
            return {
              kind: 'status',
              operation,
              relation: isCurrent ? 'current' : 'historical',
              approvalStatus: approval.status,
              policyAvailability,
              checkedAt,
            };
          }
        }
      }
      const checkedAt = store.now();
      if (!isValidExactTimestamp(checkedAt)) return { kind: 'unavailable' };
      return {
        kind: 'status',
        operation,
        relation: isCurrent ? 'current' : 'historical',
        approvalStatus: approval.status,
        policyAvailability,
        checkedAt,
      };
    });
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function closeOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  expected: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    slotGeneration: number;
    taskId: string;
    toolCallId: string;
    requestFingerprint: string;
    grantScopeFingerprint: string;
  },
  authorizeOwnerRecoveryClose: (
    operation: OwnerCallGrantOperation,
    tx: Transaction,
  ) => Promise<boolean>,
): Promise<'closed_no_effect' | 'already_committed' | 'conflict' | 'unavailable'> {
  if (
    !validScope(expected.ownerId, expected.approvalId) ||
    !UUID.test(expected.grantId) ||
    !UUID.test(expected.taskId) ||
    !UUID.test(expected.toolCallId) ||
    !HEX256.test(expected.requestFingerprint) ||
    !HEX256.test(expected.grantScopeFingerprint) ||
    !Number.isSafeInteger(expected.slotGeneration) ||
    expected.slotGeneration < 1
  )
    return 'unavailable';
  const current = await readCurrentInTransaction(tx, store, expected.ownerId, expected.approvalId);
  if (current.kind !== 'current') return 'unavailable';
  if (
    current.operation.grantId !== expected.grantId ||
    current.operation.slotGeneration !== expected.slotGeneration ||
    current.operation.taskId !== expected.taskId ||
    current.operation.toolCallId !== expected.toolCallId ||
    current.operation.requestFingerprint !== expected.requestFingerprint ||
    current.operation.grantScopeFingerprint !== expected.grantScopeFingerprint
  )
    return 'conflict';
  // Recovery authorization is separately checked against the exact operation; close is available
  // after review expiry and does not require the approval to remain pending.
  if (!(await authorizeOwnerRecoveryClose(current.operation, tx))) return 'conflict';
  if (current.operation.phase === 'committed') return 'already_committed';
  if (current.operation.phase !== 'registered' && current.operation.phase !== 'admitted')
    return 'conflict';
  const closedAt = store.now();
  if (!isValidExactTimestamp(closedAt)) return 'unavailable';
  const closed: OwnerCallGrantOperation = {
    ...current.operation,
    phase: 'closed_no_effect',
    closedAt,
    updatedAt: closedAt,
  };
  if (!parseOwnerCallGrantOperation(closed)) return 'unavailable';
  tx.update(current.operationRef, encodeOwnerCallRecord({ ...closed }));
  return 'closed_no_effect';
}

/** Owns explicit close; authorization is bound to the exact receipt and owner confirmation. */
export function closeOwnerCallGrantOperation(
  store: InstallationStore,
  expected: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    slotGeneration: number;
    taskId: string;
    toolCallId: string;
    requestFingerprint: string;
    grantScopeFingerprint: string;
  },
  authorizeOwnerRecoveryClose: (
    operation: OwnerCallGrantOperation,
    tx: Transaction,
  ) => Promise<boolean>,
): Promise<'closed_no_effect' | 'already_committed' | 'conflict' | 'unavailable'> {
  return store.db.runTransaction((tx) =>
    closeOwnerCallGrantOperationInTransaction(tx, store, expected, authorizeOwnerRecoveryClose),
  );
}

/** Only a conclusive server-side no-effect result may terminalize an operation as rejected. */
export async function rejectOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  expected: { ownerId: string; approvalId: string; grantId: string },
  proveNoEffectForExactOperation: (
    tx: Transaction,
    operation: OwnerCallGrantOperation,
  ) => Promise<boolean>,
): Promise<'rejected_no_effect' | 'committed' | 'conflict' | 'unavailable'> {
  if (!validScope(expected.ownerId, expected.approvalId) || !UUID.test(expected.grantId))
    return 'unavailable';
  // This callback must establish a conclusive non-applying result for the exact operation. Missing
  // data, timeout, elapsed expiry, and transport uncertainty are not valid proof of no effect.
  const current = await readCurrentInTransaction(tx, store, expected.ownerId, expected.approvalId);
  if (current.kind !== 'current') return 'unavailable';
  if (current.operation.grantId !== expected.grantId) return 'conflict';
  if (!(await proveNoEffectForExactOperation(tx, current.operation))) return 'conflict';
  if (current.operation.phase === 'committed') return 'committed';
  if (current.operation.phase !== 'registered' && current.operation.phase !== 'admitted')
    return 'conflict';
  const rejectedAt = store.now();
  if (!isValidExactTimestamp(rejectedAt)) return 'unavailable';
  const rejected: OwnerCallGrantOperation = {
    ...current.operation,
    phase: 'rejected_no_effect',
    rejectedAt,
    updatedAt: rejectedAt,
  };
  if (!parseOwnerCallGrantOperation(rejected)) return 'unavailable';
  tx.update(current.operationRef, encodeOwnerCallRecord({ ...rejected }));
  return 'rejected_no_effect';
}

export type OwnerCallOperationCommitPlan = {
  slotRef: DocumentReference;
  operationRef: DocumentReference;
  operation: OwnerCallGrantOperation;
};

/** Call after every existing approval/task/tool/policy/call-request read, and before any transaction write. */
export async function prepareOwnerCallGrantCommitInTransaction(
  tx: Transaction,
  store: InstallationStore,
  expected: {
    ownerId: string;
    approvalId: string;
    grantId: string;
    taskId: string;
    toolCallId: string;
    requestFingerprint: string;
    grantScopeFingerprint: string;
  },
): Promise<OwnerCallOperationCommitPlan | null> {
  if (
    !validScope(expected.ownerId, expected.approvalId) ||
    !UUID.test(expected.grantId) ||
    !UUID.test(expected.taskId) ||
    !UUID.test(expected.toolCallId) ||
    !HEX256.test(expected.requestFingerprint) ||
    !HEX256.test(expected.grantScopeFingerprint)
  )
    return null;
  const current = await readCurrentInTransaction(tx, store, expected.ownerId, expected.approvalId);
  if (current.kind !== 'current') return null;
  // Resample only after transaction document reads; a timestamp captured by the handler before a
  // slow read cannot extend either original expiry.
  const now = store.now();
  if (!isValidExactTimestamp(now)) return null;
  const op = current.operation;
  if (
    op.grantId !== expected.grantId ||
    op.taskId !== expected.taskId ||
    op.toolCallId !== expected.toolCallId ||
    op.requestFingerprint !== expected.requestFingerprint ||
    op.grantScopeFingerprint !== expected.grantScopeFingerprint ||
    op.phase !== 'admitted' ||
    compareExactTimestamps(op.reviewExpiresAt, now) <= 0 ||
    compareExactTimestamps(op.grantExpiresAt, now) <= 0
  )
    return null;
  return { slotRef: current.slotRef, operationRef: current.operationRef, operation: op };
}

export class OwnerCallOperationCommitAbort extends Error {
  readonly code = 'owner_call_operation_commit_abort';
  constructor() {
    super('Owner call operation could not be committed atomically');
    this.name = 'OwnerCallOperationCommitAbort';
  }
}

/**
 * Apply inside the caller's existing approval transaction after its decision/policy/task/outbox writes.
 * Any failure throws so Firestore aborts all caller writes rather than saving a decision without receipt.
 */
export function commitOwnerCallGrantOperationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  plan: OwnerCallOperationCommitPlan | null,
  input: { policyId: string; wakeGeneration: number; grantScopeFingerprint: string },
): OwnerCallGrantOperation {
  if (
    !plan ||
    !parseOwnerCallGrantOperation(plan.operation) ||
    plan.operation.phase !== 'admitted' ||
    !UUID.test(input.policyId) ||
    !HEX256.test(input.grantScopeFingerprint) ||
    input.grantScopeFingerprint !== plan.operation.grantScopeFingerprint ||
    !Number.isSafeInteger(input.wakeGeneration) ||
    input.wakeGeneration < 1
  )
    throw new OwnerCallOperationCommitAbort();
  // All Firestore reads are done at this point. Take one final repository clock sample immediately
  // before writing the receipt; stale handler-supplied time never decides commit eligibility.
  const committedAt = store.now();
  if (
    !isValidExactTimestamp(committedAt) ||
    compareExactTimestamps(plan.operation.reviewExpiresAt, committedAt) <= 0 ||
    compareExactTimestamps(plan.operation.grantExpiresAt, committedAt) <= 0
  )
    throw new OwnerCallOperationCommitAbort();
  const committed: OwnerCallGrantOperation = {
    ...plan.operation,
    phase: 'committed',
    committedAt,
    createdPolicyId: input.policyId,
    wakeGeneration: input.wakeGeneration,
    updatedAt: committedAt,
  };
  if (!parseOwnerCallGrantOperation(committed)) throw new OwnerCallOperationCommitAbort();
  try {
    tx.update(plan.operationRef, encodeOwnerCallRecord({ ...committed }));
  } catch {
    throw new OwnerCallOperationCommitAbort();
  }
  return committed;
}
