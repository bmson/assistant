import { createHash } from 'node:crypto';
import type {
  OwnerEditorMaintenanceInspection,
  OwnerEditorMaintenanceNativeVersion,
  OwnerEditorMaintenanceRequest,
  OwnerEditorMaintenanceRotationResult,
} from '@assistant/firestore';
import {
  type OwnerEditorEpochCursor,
  ownerEditorEpochStateDigest,
  ownerEditorMaintenanceTargetEpochDigest,
  ownerEditorPrivacyDigest,
  parseOwnerEditorEpochCursor,
} from '@assistant/persistence';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const releaseSha = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 32;
const MAX_RPC_MS = 10_000;
const MAX_RUN_MS = 60_000;
const nativeVersionSchema = z.strictObject({
  seconds: z.number().int().min(-62_135_596_800).max(253_402_300_799),
  nanoseconds: z.number().int().min(0).max(999_999_999),
});
const privacyGenerationSchema = z.string().max(512).nullable();
const identitySchema = z.strictObject({
  sourceSHA: releaseSha,
  project: z.string().min(1).max(100),
  database: z.string().min(1).max(100),
  installationId: z.string().min(1).max(100),
  ownerId: uuid,
  agentImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  agentRuntimeServiceAccount: z.string().min(1).max(254),
  webReleaseSHA: releaseSha,
  agentReleaseSHA: releaseSha,
  indexManifestSHA256: sha256,
});
const inspectRequestSchema = identitySchema.extend({ action: z.literal('inspect') }).strict();
const mutationRequestSchema = identitySchema
  .extend({
    action: z.enum(['provision-disabled', 'enable', 'disable']),
    operationId: uuid,
    requestDigest: sha256,
    targetEpoch: uuid,
    expectedEpochStateDigestOrAbsent: sha256.nullable(),
    expectedEpochNativeVersionOrAbsent: nativeVersionSchema.nullable(),
    expectedOwnerNativeVersion: nativeVersionSchema,
    expectedPrivacyDigest: sha256,
    expectedLineageDigest: sha256,
    expectedLineageNativeVersion: nativeVersionSchema,
    preflightDigest: sha256,
    maintenanceDrainEvidenceDigest: sha256,
    checkpointEvidenceDigest: sha256,
  })
  .strict();
export const ownerEditorMaintenanceRequestSchema = z.discriminatedUnion('action', [
  inspectRequestSchema,
  mutationRequestSchema,
]);

type OwnerEditorMaintenanceIdentity = z.infer<typeof identitySchema>;
export type OwnerEditorMaintenanceRunnerMutationRequest = Omit<
  Extract<OwnerEditorMaintenanceRequest, { action: 'provision-disabled' | 'enable' | 'disable' }>,
  'requestDigest'
> &
  OwnerEditorMaintenanceIdentity & {
    requestDigest: string;
    preflightDigest: string;
    maintenanceDrainEvidenceDigest: string;
    checkpointEvidenceDigest: string;
  };
type OwnerEditorMaintenanceMutationRequest = OwnerEditorMaintenanceRunnerMutationRequest;

export interface OwnerEditorMaintenanceReadinessProof {
  status: 'ready';
  preflightDigest: string;
  maintenanceDrainEvidenceDigest: string;
  checkpointEvidenceDigest: string;
}

export interface OwnerEditorMaintenancePorts {
  /** Reads identity from the independently verified fixed maintenance job. */
  readFixedRuntimeIdentity(): Promise<OwnerEditorMaintenanceIdentity>;
  /** Read-only verification of the exact approved manifest and live index readiness. */
  verifyIndexes(input: {
    identity: OwnerEditorMaintenanceIdentity;
    expectedManifestSha256: string;
  }): Promise<OwnerEditorMaintenanceCheck>;
  /** Read-only diagnostic; absence means status remains unknown. */
  inspectReadiness?(input: {
    identity: OwnerEditorMaintenanceIdentity;
  }): Promise<OwnerEditorMaintenanceCheck>;
  /** Verifies current external drain/checkpoint evidence; caller fields alone are not evidence. */
  verifyMutationReadiness(input: {
    request: OwnerEditorMaintenanceMutationRequest;
    before: OwnerEditorMaintenanceInspection;
  }): Promise<OwnerEditorMaintenanceReadinessProof>;
  storage: {
    inspect(ownerId: string): Promise<OwnerEditorMaintenanceInspection>;
    rotate(request: OwnerEditorMaintenanceRequest): Promise<OwnerEditorMaintenanceRotationResult>;
  };
}

export interface OwnerEditorMaintenanceCheck {
  status: 'ready' | 'not_ready' | 'unknown';
  manifestSha256?: string;
  diagnostic?: string;
}

export interface OwnerEditorMaintenanceSafeCursor {
  ownerId: string;
  ready: boolean;
  epochDigest: string;
  stateDigest: string;
  privacyGenerationDigest: string;
  maintenanceBinder: OwnerEditorEpochCursor['maintenanceBinder'] | null;
}

export interface OwnerEditorMaintenanceResult {
  status: 'inspected' | 'rotated' | 'replayed';
  indexReadiness: {
    status: OwnerEditorMaintenanceCheck['status'];
    manifestSha256?: string;
    diagnostic?: string;
  };
  maintenanceReadiness: { status: OwnerEditorMaintenanceCheck['status']; diagnostic?: string };
  cursor: OwnerEditorMaintenanceSafeCursor | null;
  privacyGenerationDigest: string;
  lineageDigest: string;
  ownerNativeVersion: OwnerEditorMaintenanceNativeVersion;
  epochNativeVersion: OwnerEditorMaintenanceNativeVersion | null;
  lineageNativeVersion: OwnerEditorMaintenanceNativeVersion;
  operationDigest?: string;
}

/** This source slice has no CLI, route, default SDK, workflow, or build integration. */
export const ownerEditorMaintenanceRunnerScope = Object.freeze({
  mode: 'injected-ports-only',
  cli: 'unsupported',
  defaultSdkConstruction: 'unsupported',
  route: 'unsupported',
  workflow: 'unsupported',
  buildIntegration: 'unsupported',
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function ownerEditorMaintenanceRequestDigest(
  request: Omit<OwnerEditorMaintenanceMutationRequest, 'requestDigest'>,
): string {
  return createHash('sha256')
    .update('owner-editor-maintenance-request-v1\n')
    .update(canonical(request))
    .digest('hex');
}

function assertExactIdentity(
  request: OwnerEditorMaintenanceIdentity,
  trusted: OwnerEditorMaintenanceIdentity,
): void {
  const requested = identitySchema.parse({
    sourceSHA: request.sourceSHA,
    project: request.project,
    database: request.database,
    installationId: request.installationId,
    ownerId: request.ownerId,
    agentImageDigest: request.agentImageDigest,
    agentRuntimeServiceAccount: request.agentRuntimeServiceAccount,
    webReleaseSHA: request.webReleaseSHA,
    agentReleaseSHA: request.agentReleaseSHA,
    indexManifestSHA256: request.indexManifestSHA256,
  });
  if (
    requested.sourceSHA !== requested.agentReleaseSHA ||
    canonical(requested) !== canonical(trusted)
  )
    throw new Error(
      'Maintenance target does not match the independently verified fixed-job identity',
    );
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeDeep(entry, seen);
  return Object.freeze(value);
}

function boundedDiagnostic(check: OwnerEditorMaintenanceCheck): OwnerEditorMaintenanceCheck {
  if (!['ready', 'not_ready', 'unknown'].includes(check.status))
    return { status: 'unknown', diagnostic: 'invalid readiness status' };
  const diagnostic =
    typeof check.diagnostic === 'string' &&
    check.diagnostic.length <= MAX_DIAGNOSTIC_LENGTH &&
    /^[a-z][a-z0-9_-]*$/.test(check.diagnostic)
      ? check.diagnostic
      : undefined;
  const manifestSha256 = sha256.safeParse(check.manifestSha256).success
    ? check.manifestSha256
    : undefined;
  return {
    status: check.status,
    ...(manifestSha256 ? { manifestSha256 } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function exactIndexCheck(
  check: OwnerEditorMaintenanceCheck,
  expectedManifestSha256: string,
): OwnerEditorMaintenanceCheck {
  const bounded = boundedDiagnostic(check);
  if (bounded.status === 'ready' && bounded.manifestSha256 !== expectedManifestSha256)
    return {
      status: 'not_ready',
      ...(bounded.manifestSha256 ? { manifestSha256: bounded.manifestSha256 } : {}),
      diagnostic: 'manifest_mismatch',
    };
  return bounded;
}

function boundedResult(result: OwnerEditorMaintenanceResult): OwnerEditorMaintenanceResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_BYTES)
    throw new Error('Maintenance response exceeds its fixed size cap');
  return result;
}

function withRpcDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  label: string,
): Promise<T> {
  const remaining = () => Math.min(MAX_RPC_MS, deadline - Date.now());
  if (remaining() <= 0) return Promise.reject(new Error('Maintenance run deadline elapsed'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded its bounded RPC deadline`));
    };
    timer = setTimeout(expire, remaining());
    queueMicrotask(() => {
      if (settled) return;
      const dispatchRemaining = remaining();
      if (dispatchRemaining <= 0) {
        if (timer !== undefined) clearTimeout(timer);
        settled = true;
        reject(new Error('Maintenance run deadline elapsed'));
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(expire, dispatchRemaining);
      let pending: Promise<T>;
      try {
        // Recheck at actual dispatch. Promise deadlines do not cancel a dispatched RPC.
        if (remaining() <= 0) {
          clearTimeout(timer);
          settled = true;
          reject(new Error('Maintenance run deadline elapsed'));
          return;
        }
        pending = operation();
      } catch {
        clearTimeout(timer);
        settled = true;
        reject(new Error(`${label} failed`));
        return;
      }
      pending.then(
        (value) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          resolve(value);
        },
        () => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          reject(new Error(`${label} failed`));
        },
      );
    });
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

function safeCursor(
  cursor: OwnerEditorEpochCursor | null,
): OwnerEditorMaintenanceSafeCursor | null {
  if (!cursor) return null;
  return {
    ownerId: cursor.ownerId,
    ready: cursor.ready,
    epochDigest: ownerEditorMaintenanceTargetEpochDigest(cursor.epoch),
    stateDigest: ownerEditorEpochStateDigest(cursor),
    privacyGenerationDigest: cursor.privacyGenerationDigest,
    maintenanceBinder: cursor.maintenanceBinder ?? null,
  };
}

function validateInspection(
  inspection: OwnerEditorMaintenanceInspection,
  ownerId: string,
): OwnerEditorMaintenanceInspection {
  if (
    inspection.ownerId !== ownerId ||
    !sha256.safeParse(inspection.lineageDigest).success ||
    !nativeVersionSchema.safeParse(inspection.ownerNativeVersion).success ||
    !nativeVersionSchema.safeParse(inspection.lineageNativeVersion).success ||
    (inspection.epochNativeVersion !== null &&
      !nativeVersionSchema.safeParse(inspection.epochNativeVersion).success)
  )
    throw new Error('Maintenance storage inspection is incomplete or belongs to another owner');
  let cursor: OwnerEditorEpochCursor | null;
  try {
    cursor = inspection.cursor === null ? null : parseOwnerEditorEpochCursor(inspection.cursor);
  } catch {
    throw new Error('Maintenance epoch cursor is malformed');
  }
  if (cursor && cursor.ownerId !== ownerId)
    throw new Error('Maintenance epoch cursor belongs to another owner');
  if ((cursor === null) !== (inspection.epochNativeVersion === null))
    throw new Error('Maintenance epoch cursor and native version disagree');
  return freezeDeep({
    ownerId,
    ownerNativeVersion: nativeVersionSchema.parse(inspection.ownerNativeVersion),
    epochNativeVersion:
      inspection.epochNativeVersion === null
        ? null
        : nativeVersionSchema.parse(inspection.epochNativeVersion),
    lineageNativeVersion: nativeVersionSchema.parse(inspection.lineageNativeVersion),
    privacyGeneration: privacyGenerationSchema.parse(inspection.privacyGeneration),
    lineageDigest: sha256.parse(inspection.lineageDigest),
    cursor,
  });
}

function assertOriginalObservations(
  request: OwnerEditorMaintenanceMutationRequest,
  before: OwnerEditorMaintenanceInspection,
): void {
  const actualPrivacyDigest = ownerEditorPrivacyDigest(before.privacyGeneration);
  if (
    (before.cursor ? ownerEditorEpochStateDigest(before.cursor) : null) !==
      request.expectedEpochStateDigestOrAbsent ||
    !sameVersion(before.epochNativeVersion, request.expectedEpochNativeVersionOrAbsent) ||
    !sameVersion(before.ownerNativeVersion, request.expectedOwnerNativeVersion) ||
    actualPrivacyDigest !== request.expectedPrivacyDigest ||
    before.lineageDigest !== request.expectedLineageDigest ||
    !sameVersion(before.lineageNativeVersion, request.expectedLineageNativeVersion) ||
    (before.cursor && before.cursor.privacyGenerationDigest !== actualPrivacyDigest)
  )
    throw new Error('Maintenance outcome is unknown; retain the hold and reconcile this operation');

  const cursor = before.cursor;
  const allowed =
    (request.action === 'provision-disabled' && cursor === null) ||
    (request.action === 'enable' && cursor !== null && cursor.ready === false) ||
    (request.action === 'disable' && cursor !== null);
  if (!allowed || cursor?.epoch === request.targetEpoch)
    throw new Error('Requested epoch action is not valid for the inspected state');
}

function assertReadinessProof(
  request: OwnerEditorMaintenanceMutationRequest,
  proof: OwnerEditorMaintenanceReadinessProof,
): void {
  if (
    proof.status !== 'ready' ||
    proof.preflightDigest !== request.preflightDigest ||
    proof.maintenanceDrainEvidenceDigest !== request.maintenanceDrainEvidenceDigest ||
    proof.checkpointEvidenceDigest !== request.checkpointEvidenceDigest
  )
    throw new Error('Maintenance readiness evidence does not match the trusted current checks');
}

function isExactPostWriteState(
  request: OwnerEditorMaintenanceMutationRequest,
  inspection: OwnerEditorMaintenanceInspection,
): boolean {
  const cursor = inspection.cursor;
  const binder = cursor?.maintenanceBinder;
  const privacyDigest = ownerEditorPrivacyDigest(inspection.privacyGeneration);
  return (
    inspection.ownerId === request.ownerId &&
    sameVersion(inspection.ownerNativeVersion, request.expectedOwnerNativeVersion) &&
    inspection.lineageDigest === request.expectedLineageDigest &&
    sameVersion(inspection.lineageNativeVersion, request.expectedLineageNativeVersion) &&
    privacyDigest === request.expectedPrivacyDigest &&
    cursor?.ownerId === request.ownerId &&
    cursor.epoch === request.targetEpoch &&
    cursor.ready === (request.action === 'enable') &&
    cursor.privacyGenerationDigest === request.expectedPrivacyDigest &&
    binder?.operationId === request.operationId &&
    binder.requestDigest === request.requestDigest &&
    binder.action === request.action &&
    binder.targetEpochDigest === ownerEditorMaintenanceTargetEpochDigest(request.targetEpoch)
  );
}

/**
 * Runs one maintenance request through injected trust and storage ports.
 * This module has no route, CLI, SDK default, or import-time runtime construction.
 */
export async function runOwnerEditorMaintenanceRequest(
  rawRequest: unknown,
  ports: OwnerEditorMaintenancePorts,
): Promise<OwnerEditorMaintenanceResult> {
  const deadline = Date.now() + MAX_RUN_MS;
  const invoke = <T>(label: string, operation: () => Promise<T>) =>
    withRpcDeadline(operation, deadline, label);
  let rawJson: string;
  try {
    rawJson = JSON.stringify(rawRequest);
  } catch {
    throw new Error('Maintenance request is not serializable');
  }
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > MAX_REQUEST_BYTES)
    throw new Error('Maintenance request exceeds its fixed size cap');
  let request: z.infer<typeof ownerEditorMaintenanceRequestSchema>;
  try {
    request = freezeDeep(ownerEditorMaintenanceRequestSchema.parse(rawRequest));
  } catch {
    throw new Error('Maintenance request is invalid');
  }
  if (
    request.action !== 'inspect' &&
    (request.sourceSHA !== request.agentReleaseSHA ||
      requestDigestForRequest(request) !== request.requestDigest ||
      (request.expectedEpochStateDigestOrAbsent === null) !==
        (request.expectedEpochNativeVersionOrAbsent === null))
  )
    throw new Error('Maintenance request digest, epoch absence, or source identity is invalid');
  let trustedIdentity: OwnerEditorMaintenanceIdentity;
  try {
    trustedIdentity = freezeDeep(
      identitySchema.parse(
        await invoke('Fixed-job identity', () => ports.readFixedRuntimeIdentity()),
      ),
    );
  } catch {
    throw new Error('Fixed-job identity verification is unavailable');
  }
  assertExactIdentity(request, trustedIdentity);

  let before: OwnerEditorMaintenanceInspection;
  try {
    before = validateInspection(
      await invoke('Owner/privacy/epoch inspection', () => ports.storage.inspect(request.ownerId)),
      request.ownerId,
    );
  } catch {
    throw new Error('Owner/privacy/epoch inspection is unavailable');
  }
  const privacyGenerationDigest = ownerEditorPrivacyDigest(before.privacyGeneration);
  if (request.action === 'inspect') {
    let indexReadiness: OwnerEditorMaintenanceCheck;
    try {
      indexReadiness = exactIndexCheck(
        await invoke('Index readiness inspection', () =>
          ports.verifyIndexes({
            identity: trustedIdentity,
            expectedManifestSha256: request.indexManifestSHA256,
          }),
        ),
        request.indexManifestSHA256,
      );
    } catch {
      indexReadiness = { status: 'unknown', diagnostic: 'index verification unavailable' };
    }
    let maintenanceReadiness: OwnerEditorMaintenanceResult['maintenanceReadiness'];
    if (!ports.inspectReadiness) maintenanceReadiness = { status: 'unknown' };
    else {
      try {
        const check = boundedDiagnostic(
          await invoke('Maintenance readiness inspection', () =>
            ports.inspectReadiness!({ identity: trustedIdentity }),
          ),
        );
        maintenanceReadiness = {
          status: check.status,
          ...(check.diagnostic ? { diagnostic: check.diagnostic } : {}),
        };
      } catch {
        maintenanceReadiness = {
          status: 'unknown',
          diagnostic: 'readiness verification unavailable',
        };
      }
    }
    return boundedResult({
      status: 'inspected',
      indexReadiness,
      maintenanceReadiness,
      cursor: safeCursor(before.cursor),
      privacyGenerationDigest,
      lineageDigest: before.lineageDigest,
      ownerNativeVersion: before.ownerNativeVersion,
      epochNativeVersion: before.epochNativeVersion,
      lineageNativeVersion: before.lineageNativeVersion,
    });
  }

  let indexProof: OwnerEditorMaintenanceCheck;
  try {
    indexProof = exactIndexCheck(
      await invoke('Approved index verification', () =>
        ports.verifyIndexes({
          identity: trustedIdentity,
          expectedManifestSha256: request.indexManifestSHA256,
        }),
      ),
      request.indexManifestSHA256,
    );
  } catch {
    throw new Error('Approved index verification is unavailable');
  }
  if (indexProof.status !== 'ready' || indexProof.manifestSha256 !== request.indexManifestSHA256)
    throw new Error('Approved indexes are not ready for the requested installation');

  try {
    const readiness = await invoke('External drain/checkpoint verification', () =>
      ports.verifyMutationReadiness({ request, before }),
    );
    assertReadinessProof(request, readiness);
  } catch {
    throw new Error('External drain/checkpoint verification is unavailable');
  }

  const sameOperationBinder = before.cursor?.maintenanceBinder?.operationId === request.operationId;
  if (sameOperationBinder && !isExactPostWriteState(request, before))
    throw new Error('Maintenance outcome is unknown; retain the hold and reconcile this operation');
  if (!sameOperationBinder) assertOriginalObservations(request, before);
  else {
    // External checks are asynchronous. Re-observe the original binding and
    // privacy/lineage guards after them rather than returning a stale snapshot.
    let readback: OwnerEditorMaintenanceInspection;
    try {
      readback = validateInspection(
        await invoke('Original operation replay readback', () =>
          ports.storage.inspect(request.ownerId),
        ),
        request.ownerId,
      );
    } catch {
      throw new Error(
        'Maintenance outcome is unknown; retain the hold and reconcile this operation',
      );
    }
    if (!isExactPostWriteState(request, readback))
      throw new Error(
        'Maintenance outcome is unknown; retain the hold and reconcile this operation',
      );
    return boundedResult(resultFor('replayed', readback, request.requestDigest, indexProof));
  }

  let operationStatus: 'rotated' | 'replayed' | 'unknown' = 'unknown';
  try {
    operationStatus = (
      await invoke('Native epoch rotation', () =>
        ports.storage.rotate(freezeDeep(coreMutationRequest(request))),
      )
    ).status;
  } catch {
    // Promise deadlines cannot cancel a native request; late completion remains possible under
    // the hold. Only exact readback resolves the operation, and no retry is issued here.
  }
  let after: OwnerEditorMaintenanceInspection;
  try {
    after = validateInspection(
      await invoke('Post-rotation native readback', () => ports.storage.inspect(request.ownerId)),
      request.ownerId,
    );
  } catch {
    throw new Error('Maintenance outcome is unknown; retain the hold and reconcile this operation');
  }
  if (!isExactPostWriteState(request, after))
    throw new Error('Maintenance outcome is unknown; retain the hold and reconcile this operation');

  return boundedResult(
    resultFor(
      operationStatus === 'rotated' ? 'rotated' : 'replayed',
      after,
      request.requestDigest,
      indexProof,
    ),
  );
}

function resultFor(
  status: OwnerEditorMaintenanceResult['status'],
  inspection: OwnerEditorMaintenanceInspection,
  operationDigest?: string,
  indexReadiness: OwnerEditorMaintenanceCheck = { status: 'unknown' },
  maintenanceReadiness: OwnerEditorMaintenanceResult['maintenanceReadiness'] = {
    status: status === 'inspected' ? 'unknown' : 'ready',
  },
): OwnerEditorMaintenanceResult {
  return {
    status,
    indexReadiness,
    maintenanceReadiness,
    cursor: safeCursor(inspection.cursor),
    privacyGenerationDigest: ownerEditorPrivacyDigest(inspection.privacyGeneration),
    lineageDigest: inspection.lineageDigest,
    ownerNativeVersion: inspection.ownerNativeVersion,
    epochNativeVersion: inspection.epochNativeVersion,
    lineageNativeVersion: inspection.lineageNativeVersion,
    ...(operationDigest ? { operationDigest } : {}),
  };
}

function requestDigestForRequest(request: OwnerEditorMaintenanceMutationRequest): string {
  const { requestDigest: _requestDigest, ...binding } = request;
  return ownerEditorMaintenanceRequestDigest(binding);
}

function coreMutationRequest(
  request: OwnerEditorMaintenanceMutationRequest,
): OwnerEditorMaintenanceRequest {
  return {
    ownerId: request.ownerId,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    action: request.action,
    targetEpoch: request.targetEpoch,
    expectedEpochStateDigestOrAbsent: request.expectedEpochStateDigestOrAbsent,
    expectedEpochNativeVersionOrAbsent: request.expectedEpochNativeVersionOrAbsent,
    expectedOwnerNativeVersion: request.expectedOwnerNativeVersion,
    expectedPrivacyDigest: request.expectedPrivacyDigest,
    expectedLineageDigest: request.expectedLineageDigest,
    expectedLineageNativeVersion: request.expectedLineageNativeVersion,
  };
}
