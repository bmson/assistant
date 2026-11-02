import {
  type OwnerEditorExpiredClaimExpectation,
  type OwnerEditorRecoveryFreshSnapshot,
  type OwnerEditorRecoveryMaintenanceState,
  type OwnerEditorRecoveryStorage,
  type OwnerEditorRecoveryStorageOptions,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  parseOwnerEditorEpochCursor,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { agents, maintenanceCursors, ownerEditorOperations } from './schema.js';

const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;
const replayWindowMs = 24 * 60 * 60_000;
type Tx = Pick<Db, 'select' | 'update'>;

function validMaintenance(value: unknown): OwnerEditorRecoveryMaintenanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Recovery maintenance state is unavailable');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (
    keys !== 'driver,postgresSourceWritesFenced,releaseWritesPaused,restoreRehearsal' ||
    (v.driver !== 'postgres' && v.driver !== 'firestore') ||
    typeof v.releaseWritesPaused !== 'boolean' ||
    typeof v.restoreRehearsal !== 'boolean' ||
    typeof v.postgresSourceWritesFenced !== 'boolean'
  )
    throw new Error('Recovery maintenance state is malformed');
  return {
    driver: v.driver,
    releaseWritesPaused: v.releaseWritesPaused,
    restoreRehearsal: v.restoreRehearsal,
    postgresSourceWritesFenced: v.postgresSourceWritesFenced,
  };
}

function sameMaintenance(
  a: OwnerEditorRecoveryMaintenanceState,
  b: OwnerEditorRecoveryMaintenanceState,
): boolean {
  return (
    a.driver === b.driver &&
    a.releaseWritesPaused === b.releaseWritesPaused &&
    a.restoreRehearsal === b.restoreRehearsal &&
    a.postgresSourceWritesFenced === b.postgresSourceWritesFenced
  );
}

function requireClearPostgresMaintenance(value: OwnerEditorRecoveryMaintenanceState): void {
  if (
    value.driver !== 'postgres' ||
    value.releaseWritesPaused ||
    value.restoreRehearsal ||
    value.postgresSourceWritesFenced
  )
    throw new Error('PostgreSQL recovery writes are unavailable');
}

function requireReadablePostgresMaintenance(value: OwnerEditorRecoveryMaintenanceState): void {
  if (value.driver !== 'postgres' || value.releaseWritesPaused || value.restoreRehearsal)
    throw new Error('PostgreSQL recovery reads are unavailable');
}

function assertDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error(`Recovery ${name} is invalid`);
}

function matchesExpected(
  scope: OwnerEditorScope,
  record: ReturnType<typeof parseOwnerEditorOperationRecord> | null,
  expected: OwnerEditorExpiredClaimExpectation,
): record is ReturnType<typeof parseOwnerEditorOperationRecord> {
  return Boolean(
    record &&
      record.id === ownerEditorOperationId(scope) &&
      record.ownerId === scope.ownerId &&
      record.epoch === scope.epoch &&
      record.privacyGenerationDigest === ownerEditorPrivacyDigest(scope.privacyGeneration) &&
      record.operationId === scope.operationId &&
      record.command === scope.command &&
      record.scopeDigest === ownerEditorScopeDigest(scope) &&
      record.protocolVersion === 1 &&
      record.formIssuedAt.getTime() === scope.issuedAt &&
      record.formExpiresAt.getTime() === scope.expiresAt &&
      record.requestHash === expected.requestHash &&
      record.status === 'preparing' &&
      record.statusVersion === expected.statusVersion &&
      record.claimToken === expected.claimToken &&
      record.claimExpiresAt?.getTime() === expected.claimExpiresAt.getTime(),
  );
}

async function readCurrent(tx: Tx, scope: OwnerEditorScope) {
  const privacyGeneration = await lockPostgresPrivacyObservationFence(tx, scope.ownerId);
  const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
  if (owners.length !== 1 || owners[0]?.id !== scope.ownerId)
    throw new Error('Recovery owner is unavailable');
  const [cursor] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, epochName(scope.ownerId)))
    .for('update')
    .limit(1);
  if (typeof cursor?.cursor !== 'string') throw new Error('Recovery epoch is unavailable');
  const parsed = parseOwnerEditorEpochCursor(JSON.parse(cursor.cursor));
  if (
    parsed.ownerId !== scope.ownerId ||
    parsed.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyGeneration)
  )
    throw new Error('Recovery epoch is malformed');
  return {
    current: {
      ownerId: scope.ownerId,
      epoch: parsed.epoch,
      privacyGeneration,
      ready: parsed.ready,
    },
  };
}

async function readOperation(tx: Tx, scope: OwnerEditorScope) {
  const [row] = await tx
    .select()
    .from(ownerEditorOperations)
    .where(
      and(
        eq(ownerEditorOperations.id, ownerEditorOperationId(scope)),
        eq(ownerEditorOperations.ownerId, scope.ownerId),
      ),
    )
    .for('update')
    .limit(1);
  return row ? parseOwnerEditorOperationRecord(row) : null;
}

/** PostgreSQL-only dormant V2 adapter. It can read or abandon one old claim. */
export function createPostgresOwnerEditorRecoveryStorage(
  db: Db,
  options: OwnerEditorRecoveryStorageOptions,
): OwnerEditorRecoveryStorage {
  return {
    async withRecoveryTransaction(scope, run) {
      return db.transaction(async (tx) => {
        const readFresh = async (): Promise<OwnerEditorRecoveryFreshSnapshot> => {
          if (!(await options.authorize(scope))) throw new Error('Recovery authorization expired');
          const maintenance = validMaintenance(await options.readMaintenance());
          requireReadablePostgresMaintenance(maintenance);
          const { current } = await readCurrent(tx, scope);
          const operation = await readOperation(tx, scope);
          return { current, maintenance, operation };
        };

        const transaction = {
          readFresh,
          async abandonExpiredOriginal(expected: OwnerEditorExpiredClaimExpectation) {
            const sealedExpected: OwnerEditorExpiredClaimExpectation = {
              ...expected,
              scope: Object.freeze({ ...expected.scope }),
              session: Object.freeze({ ...expected.session }),
              claimExpiresAt: new Date(expected.claimExpiresAt),
              now: new Date(expected.now),
              proofExpiresAt: new Date(expected.proofExpiresAt),
              replayExpiresAt: new Date(expected.replayExpiresAt),
              maintenance: Object.freeze({ ...expected.maintenance }),
            };
            expected = sealedExpected;
            assertDate(expected.claimExpiresAt, 'claim expiry');
            assertDate(expected.now, 'observation time');
            assertDate(expected.proofExpiresAt, 'proof expiry');
            assertDate(expected.replayExpiresAt, 'replay expiry');
            if (
              expected.scope.ownerId !== scope.ownerId ||
              expected.scope.operationId !== scope.operationId ||
              expected.scope.epoch !== scope.epoch ||
              ownerEditorScopeDigest(expected.scope) !== ownerEditorScopeDigest(scope) ||
              expected.session.ownerId !== scope.ownerId ||
              typeof expected.session.formSessionScope !== 'string' ||
              !expected.session.formSessionScope.trim() ||
              expected.requestHash.length !== 64 ||
              !/^[a-f0-9]{64}$/.test(expected.requestHash) ||
              !/^[0-9a-f-]{36}$/i.test(expected.claimToken) ||
              !Number.isSafeInteger(expected.statusVersion) ||
              expected.statusVersion < 1 ||
              expected.replayExpiresAt.getTime() !== scope.issuedAt + replayWindowMs ||
              expected.proofExpiresAt.getTime() <= expected.now.getTime() ||
              expected.proofExpiresAt.getTime() - expected.now.getTime() > 120_000 ||
              expected.replayExpiresAt.getTime() <= expected.now.getTime()
            )
              return null;

            if (!(await options.authorize(scope, expected.session)))
              throw new Error('Recovery authorization expired');
            const maintenance = validMaintenance(await options.readMaintenance());
            requireClearPostgresMaintenance(maintenance);
            if (!sameMaintenance(maintenance, expected.maintenance))
              throw new Error('Recovery maintenance state changed');
            const { current } = await readCurrent(tx, scope);
            if (
              current.ownerId !== scope.ownerId ||
              current.epoch !== scope.epoch ||
              current.privacyGeneration !== scope.privacyGeneration ||
              !current.ready
            )
              return null;
            const record = await readOperation(tx, scope);
            if (!matchesExpected(scope, record, expected)) return record;

            // Recheck request and configured holds immediately before the CAS.
            if (!(await options.authorize(scope, expected.session)))
              throw new Error('Recovery authorization expired');
            const latestMaintenance = validMaintenance(await options.readMaintenance());
            requireClearPostgresMaintenance(latestMaintenance);
            if (!sameMaintenance(latestMaintenance, expected.maintenance))
              throw new Error('Recovery maintenance state changed');

            const result = { outcome: 'not_applied', reason: 'claim_abandoned' } as const;
            const [written] = await tx
              .update(ownerEditorOperations)
              .set({
                status: 'abandoned',
                result,
                claimToken: null,
                claimExpiresAt: null,
                statusVersion: expected.statusVersion + 1,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(
                and(
                  eq(ownerEditorOperations.id, ownerEditorOperationId(scope)),
                  eq(ownerEditorOperations.ownerId, scope.ownerId),
                  eq(ownerEditorOperations.epoch, scope.epoch),
                  eq(
                    ownerEditorOperations.privacyGenerationDigest,
                    ownerEditorPrivacyDigest(scope.privacyGeneration),
                  ),
                  eq(ownerEditorOperations.operationId, scope.operationId),
                  eq(ownerEditorOperations.command, scope.command),
                  eq(ownerEditorOperations.scopeDigest, ownerEditorScopeDigest(scope)),
                  eq(ownerEditorOperations.protocolVersion, 1),
                  eq(ownerEditorOperations.formIssuedAt, new Date(scope.issuedAt)),
                  eq(ownerEditorOperations.formExpiresAt, new Date(scope.expiresAt)),
                  eq(ownerEditorOperations.requestHash, expected.requestHash),
                  eq(ownerEditorOperations.status, 'preparing'),
                  eq(ownerEditorOperations.statusVersion, expected.statusVersion),
                  eq(ownerEditorOperations.claimToken, expected.claimToken),
                  eq(ownerEditorOperations.claimExpiresAt, expected.claimExpiresAt),
                  lte(ownerEditorOperations.claimExpiresAt, sql`clock_timestamp()`),
                  sql`clock_timestamp() < ${expected.proofExpiresAt}`,
                  sql`clock_timestamp() < ${expected.replayExpiresAt}`,
                ),
              )
              .returning();
            if (written) return parseOwnerEditorOperationRecord(written);
            return readOperation(tx, scope);
          },
        };
        return run(transaction);
      });
    },
  };
}
