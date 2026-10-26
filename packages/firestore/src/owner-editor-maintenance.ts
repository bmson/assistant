import {
  type OwnerEditorEpochCursor,
  ownerEditorEpochStateDigest,
  ownerEditorMaintenanceTargetEpochDigest,
  ownerEditorPrivacyDigest,
  ownerEditorSnapshotRevision,
  parseOwnerEditorEpochCursor,
  parseOwnerEditorMaintenanceBinder,
} from '@assistant/persistence';
import { type DocumentSnapshot, Timestamp, type Transaction } from '@google-cloud/firestore';
import { z } from 'zod';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

export interface OwnerEditorMaintenanceNativeVersion {
  seconds: number;
  nanoseconds: number;
}
export interface OwnerEditorMaintenanceInspection {
  ownerId: string;
  ownerNativeVersion: OwnerEditorMaintenanceNativeVersion;
  cursor: OwnerEditorEpochCursor | null;
  epochNativeVersion: OwnerEditorMaintenanceNativeVersion | null;
  privacyGeneration: string | null;
  lineageDigest: string;
  lineageNativeVersion: OwnerEditorMaintenanceNativeVersion;
}
export interface OwnerEditorMaintenanceRequest {
  ownerId: string;
  operationId: string;
  requestDigest: string;
  action: 'provision-disabled' | 'enable' | 'disable';
  /** Selected by the trusted caller once, before any SDK callback/retry. */
  targetEpoch: string;
  expectedEpochStateDigestOrAbsent: string | null;
  expectedEpochNativeVersionOrAbsent: OwnerEditorMaintenanceNativeVersion | null;
  expectedOwnerNativeVersion: OwnerEditorMaintenanceNativeVersion;
  expectedPrivacyDigest: string;
  expectedLineageDigest: string;
  expectedLineageNativeVersion: OwnerEditorMaintenanceNativeVersion;
}
export interface OwnerEditorMaintenanceRotationResult {
  status: 'rotated' | 'replayed';
  cursor: OwnerEditorEpochCursor;
}

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.strictObject({
  seconds: z.number().int().min(-62_135_596_800).max(253_402_300_799),
  nanoseconds: z.number().int().min(0).max(999_999_999),
});
const requestSchema = z
  .strictObject({
    ownerId: uuid,
    operationId: uuid,
    requestDigest: hash,
    action: z.enum(['provision-disabled', 'enable', 'disable']),
    targetEpoch: uuid,
    expectedEpochStateDigestOrAbsent: hash.nullable(),
    expectedEpochNativeVersionOrAbsent: version.nullable(),
    expectedOwnerNativeVersion: version,
    expectedPrivacyDigest: hash,
    expectedLineageDigest: hash,
    expectedLineageNativeVersion: version,
  })
  .refine(
    (request) =>
      (request.expectedEpochStateDigestOrAbsent === null) ===
      (request.expectedEpochNativeVersionOrAbsent === null),
    'Epoch absence must agree with its native observation',
  );
const targetSchema = z.strictObject({
  projectId: z.string().min(1).max(100),
  databaseId: z.string().min(1).max(100),
  installationId: z.string().min(1).max(100),
});
const activationSchema = z.strictObject({
  sourceWriteFenceId: z.string().trim().min(1).max(512),
  sourceWritesDrainedAt: z.instanceof(Timestamp),
  snapshotUri: z
    .string()
    .regex(/^gs:\/\/[^\s]+$/)
    .max(2_048),
  snapshotGeneration: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(100),
  snapshotSha256: hash,
});
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;

function nativeVersion(snapshot: DocumentSnapshot): OwnerEditorMaintenanceNativeVersion {
  if (!snapshot.exists || !snapshot.updateTime)
    throw new Error('Maintenance native observation is unavailable');
  return version.parse({
    seconds: snapshot.updateTime.seconds,
    nanoseconds: snapshot.updateTime.nanoseconds,
  });
}
function sameVersion(
  left: OwnerEditorMaintenanceNativeVersion | null,
  right: OwnerEditorMaintenanceNativeVersion | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.seconds === right.seconds && left.nanoseconds === right.nanoseconds;
}

/** Historical activation identifies the installation; it is NOT a fresh drain/checkpoint. */
function lineageDigest(
  store: InstallationStore,
  ownerId: string,
  marker: DocumentSnapshot,
): string {
  if (
    !marker.exists ||
    marker.id !== documentKey('migration') ||
    marker.get('status') !== 'active' ||
    marker.get('sourceAgentId') !== ownerId
  )
    throw new Error('Maintenance installation lineage is unsupported');
  const target = targetSchema.parse(marker.get('target'));
  if (
    target.projectId !== store.projectId ||
    target.databaseId !== store.databaseId ||
    target.installationId !== store.installationId
  )
    throw new Error('Maintenance installation target does not match');
  const formatVersion = z.number().int().min(1).max(3).parse(marker.get('formatVersion'));
  const bundleChecksum = hash.parse(marker.get('bundleChecksum'));
  const totalWrites = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(marker.get('totalWrites'));
  if (marker.get('completedWrites') !== totalWrites)
    throw new Error('Maintenance installation lineage is incomplete');
  const activation = activationSchema.parse(marker.get('activation'));
  const drainedAt = version.parse({
    seconds: activation.sourceWritesDrainedAt.seconds,
    nanoseconds: activation.sourceWritesDrainedAt.nanoseconds,
  });
  return ownerEditorSnapshotRevision({
    kind: 'owner-editor-maintenance-active-lineage-v1',
    ownerId,
    target,
    status: 'active',
    formatVersion,
    bundleChecksum,
    completedWrites: totalWrites,
    totalWrites,
    activation: { ...activation, sourceWritesDrainedAt: drainedAt },
  });
}

async function inspectInTransaction(
  tx: Transaction,
  store: InstallationStore,
  ownerId: string,
): Promise<OwnerEditorMaintenanceInspection> {
  uuid.parse(ownerId);
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.id !== documentKey(ownerId) ||
    owner.get('id') !== ownerId
  )
    throw new Error('Maintenance physical owner is unavailable');
  const [privacy, epoch, lineage] = await tx.getAll(
    store.doc('privacyErasureJobs', ownerId),
    store.doc('maintenanceCursors', epochName(ownerId)),
    store.doc('coordination', 'migration'),
  );
  if (!privacy || !epoch || !lineage) throw new Error('Maintenance metadata is unavailable');
  const privacyGeneration = ownerEditorFirestorePrivacyToken(privacy, ownerId);
  let cursor: OwnerEditorEpochCursor | null = null;
  if (epoch.exists) {
    if (epoch.id !== documentKey(epochName(ownerId)) || epoch.get('name') !== epochName(ownerId))
      throw new Error('Maintenance epoch identity is malformed');
    cursor = parseOwnerEditorEpochCursor(JSON.parse(String(epoch.get('cursor'))));
    if (
      cursor.ownerId !== ownerId ||
      cursor.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyGeneration)
    )
      throw new Error('Maintenance epoch privacy or owner changed');
  }
  return {
    ownerId,
    ownerNativeVersion: nativeVersion(owner),
    cursor,
    epochNativeVersion: epoch.exists ? nativeVersion(epoch) : null,
    privacyGeneration,
    lineageDigest: lineageDigest(store, ownerId, lineage),
    lineageNativeVersion: nativeVersion(lineage),
  };
}

/** Read-only and bounded; unsupported lineage is not permission to create an epoch. */
export async function inspectFirestoreOwnerEditorMaintenanceState(
  store: InstallationStore,
  ownerId: string,
): Promise<OwnerEditorMaintenanceInspection> {
  return store.db.runTransaction((tx) => inspectInTransaction(tx, store, ownerId), {
    readOnly: true,
  });
}

/** Trusted caller must separately establish and retain ingress/worker/recovery holds. */
export async function rotateFirestoreOwnerEditorEpochForMaintenance(
  store: InstallationStore,
  rawRequest: OwnerEditorMaintenanceRequest,
): Promise<OwnerEditorMaintenanceRotationResult> {
  const request = requestSchema.parse(rawRequest);
  // The original request and target are frozen outside all SDK callbacks.
  const sealed = JSON.parse(JSON.stringify(request)) as OwnerEditorMaintenanceRequest;
  return store.db.runTransaction<OwnerEditorMaintenanceRotationResult>(
    async (tx) => {
      const value = await inspectInTransaction(tx, store, sealed.ownerId);
      if (
        !sameVersion(value.ownerNativeVersion, sealed.expectedOwnerNativeVersion) ||
        ownerEditorPrivacyDigest(value.privacyGeneration) !== sealed.expectedPrivacyDigest ||
        value.lineageDigest !== sealed.expectedLineageDigest ||
        !sameVersion(value.lineageNativeVersion, sealed.expectedLineageNativeVersion)
      )
        throw new Error('Maintenance owner, privacy or installation lineage changed');

      const targetReady = sealed.action === 'enable';
      const targetDigest = ownerEditorMaintenanceTargetEpochDigest(sealed.targetEpoch);
      if (value.cursor?.maintenanceBinder?.operationId === sealed.operationId) {
        const binder = parseOwnerEditorMaintenanceBinder(value.cursor.maintenanceBinder);
        if (
          binder.requestDigest !== sealed.requestDigest ||
          binder.action !== sealed.action ||
          binder.targetEpochDigest !== targetDigest ||
          value.cursor.epoch !== sealed.targetEpoch ||
          value.cursor.ready !== targetReady
        )
          throw new Error('Maintenance original operation binding is unresolved');
        // Its own successful write changed epoch updateTime. Original pre-write
        // version comparisons apply only to NEW operations, never this replay.
        return { status: 'replayed', cursor: value.cursor };
      }

      const actualDigest = value.cursor ? ownerEditorEpochStateDigest(value.cursor) : null;
      if (
        actualDigest !== sealed.expectedEpochStateDigestOrAbsent ||
        !sameVersion(value.epochNativeVersion, sealed.expectedEpochNativeVersionOrAbsent)
      )
        throw new Error('Maintenance original epoch observation changed');
      if (
        (sealed.action === 'provision-disabled' && value.cursor !== null) ||
        (sealed.action === 'enable' && (!value.cursor || value.cursor.ready)) ||
        (sealed.action === 'disable' && !value.cursor) ||
        value.cursor?.epoch === sealed.targetEpoch
      )
        throw new Error('Maintenance rotation transition is unsupported');

      const cursor = parseOwnerEditorEpochCursor({
        ownerId: sealed.ownerId,
        epoch: sealed.targetEpoch,
        ready: targetReady,
        privacyGenerationDigest: sealed.expectedPrivacyDigest,
        maintenanceBinder: {
          version: 1,
          operationId: sealed.operationId,
          requestDigest: sealed.requestDigest,
          action: sealed.action,
          targetEpochDigest: targetDigest,
        },
      });
      const name = epochName(sealed.ownerId);
      tx.set(
        store.doc('maintenanceCursors', name),
        encodeRecord({
          name,
          updatedAt: store.now(),
          cursor: JSON.stringify(cursor),
        }),
      );
      return { status: 'rotated', cursor };
    },
    { maxAttempts: 3 },
  );
}
