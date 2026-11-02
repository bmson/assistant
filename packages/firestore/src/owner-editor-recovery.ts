import {
  type OwnerEditorOperationRecord,
  type OwnerEditorRecoveryFreshSnapshot,
  type OwnerEditorRecoveryMaintenanceState,
  type OwnerEditorRecoveryStorage,
  type OwnerEditorRecoveryStorageOptions,
  type OwnerEditorRecoveryTransaction,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  parseOwnerEditorEpochCursor,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const OWNER_EDITOR_EPOCH_PREFIX = 'owner-editor-epoch:';
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const RECOVERY_COMMANDS = new Set([
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
  'create_owner_memory',
]);
const MAINTENANCE_KEYS = [
  'driver',
  'postgresSourceWritesFenced',
  'releaseWritesPaused',
  'restoreRehearsal',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactMaintenance(value: unknown): OwnerEditorRecoveryMaintenanceState | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== MAINTENANCE_KEYS.length ||
    keys.some((key, index) => key !== [...MAINTENANCE_KEYS].sort()[index])
  )
    return null;
  if (
    value.driver !== 'firestore' ||
    typeof value.releaseWritesPaused !== 'boolean' ||
    typeof value.restoreRehearsal !== 'boolean' ||
    typeof value.postgresSourceWritesFenced !== 'boolean'
  )
    return null;
  return value as unknown as OwnerEditorRecoveryMaintenanceState;
}

function maintenanceAllowsRecovery(value: OwnerEditorRecoveryMaintenanceState): boolean {
  return value.driver === 'firestore' && !value.releaseWritesPaused && !value.restoreRehearsal;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function equalMaintenance(
  left: OwnerEditorRecoveryMaintenanceState,
  right: OwnerEditorRecoveryMaintenanceState,
): boolean {
  return (
    left.driver === right.driver &&
    left.releaseWritesPaused === right.releaseWritesPaused &&
    left.restoreRehearsal === right.restoreRehearsal &&
    left.postgresSourceWritesFenced === right.postgresSourceWritesFenced
  );
}

function exactOperation(
  value: unknown,
  scope: OwnerEditorScope,
): OwnerEditorOperationRecord | null {
  if (!RECOVERY_COMMANDS.has(scope.command)) return null;
  let operation: OwnerEditorOperationRecord;
  try {
    operation = parseOwnerEditorOperationRecord(value);
  } catch {
    return null;
  }
  return operation.id === ownerEditorOperationId(scope) &&
    operation.ownerId === scope.ownerId &&
    operation.epoch === scope.epoch &&
    operation.privacyGenerationDigest === ownerEditorPrivacyDigest(scope.privacyGeneration) &&
    operation.operationId === scope.operationId &&
    operation.command === scope.command &&
    operation.scopeDigest === ownerEditorScopeDigest(scope) &&
    operation.protocolVersion === 1 &&
    operation.formIssuedAt.getTime() === scope.issuedAt &&
    operation.formExpiresAt.getTime() === scope.expiresAt
    ? operation
    : null;
}

function sameScope(left: OwnerEditorScope, right: OwnerEditorScope): boolean {
  return ownerEditorScopeDigest(left) === ownerEditorScopeDigest(right);
}

function sameExpiredClaim(
  operation: OwnerEditorOperationRecord,
  expected: Parameters<OwnerEditorRecoveryTransaction['abandonExpiredOriginal']>[0],
  now: Date,
): boolean {
  const replayDeadline = expected.scope.issuedAt + REPLAY_WINDOW_MS;
  return (
    validDate(expected.claimExpiresAt) &&
    validDate(expected.now) &&
    validDate(expected.proofExpiresAt) &&
    validDate(expected.replayExpiresAt) &&
    operation.status === 'preparing' &&
    operation.requestHash === expected.requestHash &&
    operation.claimToken === expected.claimToken &&
    operation.claimExpiresAt?.getTime() === expected.claimExpiresAt.getTime() &&
    operation.statusVersion === expected.statusVersion &&
    Number.isSafeInteger(expected.statusVersion) &&
    expected.statusVersion > 0 &&
    expected.now.getTime() <= now.getTime() &&
    expected.claimExpiresAt.getTime() <= expected.now.getTime() &&
    expected.proofExpiresAt.getTime() > now.getTime() &&
    expected.proofExpiresAt.getTime() - expected.now.getTime() <= 120_000 &&
    expected.replayExpiresAt.getTime() === replayDeadline &&
    now.getTime() < expected.replayExpiresAt.getTime() &&
    now.getTime() < replayDeadline
  );
}

async function readOwner(
  tx: Transaction,
  store: InstallationStore,
  ownerId: string,
): Promise<void> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.get('id') !== ownerId ||
    owner.id !== documentKey(ownerId)
  )
    throw new Error('Recovery owner is unavailable');
}

async function readFreshSnapshot(
  tx: Transaction,
  store: InstallationStore,
  scope: OwnerEditorScope,
  options: OwnerEditorRecoveryStorageOptions,
): Promise<OwnerEditorRecoveryFreshSnapshot> {
  if (!RECOVERY_COMMANDS.has(scope.command)) throw new Error('Recovery command is unavailable');
  if (!(await options.authorize(scope))) throw new Error('Recovery request authorization changed');

  const maintenance = exactMaintenance(await options.readMaintenance());
  if (!maintenance) throw new Error('Recovery maintenance state is unavailable');

  await readOwner(tx, store, scope.ownerId);
  const operationId = ownerEditorOperationId(scope);
  const epochName = `${OWNER_EDITOR_EPOCH_PREFIX}${scope.ownerId}`;
  const operationRef = store.doc('ownerEditorOperations', operationId);
  const [privacyJob, epoch, operationSnapshot] = await tx.getAll(
    store.doc('privacyErasureJobs', scope.ownerId),
    store.doc('maintenanceCursors', epochName),
    operationRef,
  );
  if (!privacyJob || !epoch || !operationSnapshot)
    throw new Error('Recovery metadata is unavailable');

  const privacyGeneration = ownerEditorFirestorePrivacyToken(
    privacyJob as DocumentSnapshot,
    scope.ownerId,
  );
  let cursor: ReturnType<typeof parseOwnerEditorEpochCursor>;
  if (!epoch.exists || epoch.get('name') !== epochName || typeof epoch.get('cursor') !== 'string')
    throw new Error('Recovery epoch is unavailable');
  try {
    cursor = parseOwnerEditorEpochCursor(JSON.parse(epoch.get('cursor') as string));
  } catch {
    throw new Error('Recovery epoch is malformed');
  }
  if (
    cursor.ownerId !== scope.ownerId ||
    cursor.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyGeneration)
  )
    throw new Error('Recovery epoch privacy binding is unavailable');

  let operation: OwnerEditorOperationRecord | null = null;
  if (operationSnapshot.exists) {
    if (operationSnapshot.id !== documentKey(operationId))
      throw new Error('Recovery operation physical identity is invalid');
    try {
      operation = exactOperation(decodeRecord(operationSnapshot.data()), scope);
    } catch {
      operation = null;
    }
    if (!operation) throw new Error('Recovery operation identity is unavailable');
  }

  return {
    current: {
      ownerId: cursor.ownerId,
      epoch: cursor.epoch,
      privacyGeneration,
      ready: cursor.ready,
    },
    maintenance,
    operation,
  };
}

/**
 * Storage-only Firestore adapter for the dormant V2 recovery service. The one
 * write is an exact compare-and-set on the original journal row; this adapter
 * has no reserve, apply, domain, provider, or primary-data surface.
 */
export function createFirestoreOwnerEditorRecoveryStorage(
  store: InstallationStore,
  options: OwnerEditorRecoveryStorageOptions,
): OwnerEditorRecoveryStorage {
  return {
    async withRecoveryTransaction(scope, run) {
      const initialMaintenance = exactMaintenance(await options.readMaintenance());
      if (!initialMaintenance || !maintenanceAllowsRecovery(initialMaintenance))
        throw new Error('Recovery maintenance hold is active');

      return store.db.runTransaction(
        async (tx) => {
          const callbackClock = thisNow(store, options);
          if (scope.issuedAt > callbackClock.getTime())
            throw new Error('Recovery form scope is not yet valid');
          let snapshot: OwnerEditorRecoveryFreshSnapshot | null = null;
          let wrote = false;
          const transaction: OwnerEditorRecoveryTransaction = {
            async readFresh() {
              if (wrote) throw new Error('Recovery transaction cannot read after its write');
              snapshot = await readFreshSnapshot(tx, store, scope, options);
              return snapshot;
            },
            async abandonExpiredOriginal(expected) {
              if (wrote || !snapshot) return null;
              if (
                !sameScope(scope, expected.scope) ||
                expected.session.ownerId !== scope.ownerId ||
                !expected.session.formSessionScope ||
                snapshot.current.ownerId !== scope.ownerId ||
                snapshot.current.epoch !== scope.epoch ||
                snapshot.current.privacyGeneration !== scope.privacyGeneration ||
                !snapshot.current.ready ||
                !maintenanceAllowsRecovery(snapshot.maintenance) ||
                !maintenanceAllowsRecovery(expected.maintenance)
              )
                return null;

              const operation = exactOperation(snapshot.operation, scope);
              if (
                !operation ||
                !sameExpiredClaim(operation, expected, thisNow(store, options)) ||
                !(await options.authorize(scope, expected.session))
              )
                return null;

              const maintenance = exactMaintenance(await options.readMaintenance());
              if (!maintenance || !maintenanceAllowsRecovery(maintenance)) return null;
              if (
                !equalMaintenance(maintenance, snapshot.maintenance) ||
                !equalMaintenance(maintenance, expected.maintenance)
              )
                return null;

              const now = thisNow(store, options);
              if (!sameExpiredClaim(operation, expected, now)) return null;
              const updated = parseOwnerEditorOperationRecord({
                ...operation,
                claimToken: null,
                claimExpiresAt: null,
                status: 'abandoned',
                statusVersion: operation.statusVersion + 1,
                result: { outcome: 'not_applied', reason: 'claim_abandoned' },
                updatedAt: now,
              });
              const operationId = ownerEditorOperationId(scope);
              tx.update(store.doc('ownerEditorOperations', operationId), encodeRecord(updated));
              wrote = true;
              snapshot = { ...snapshot, operation: updated };
              return updated;
            },
          };
          return run(transaction);
        },
        // InstallationStore's emulator-only retry wrapper can invoke this
        // three-attempt SDK transaction at most three times (nine callbacks).
        { maxAttempts: 3 },
      );
    },
  };
}

function thisNow(store: InstallationStore, options: OwnerEditorRecoveryStorageOptions): Date {
  const value = options.now ? options.now() : store.now();
  if (!validDate(value)) throw new Error('Recovery storage clock is invalid');
  return new Date(value.getTime());
}
