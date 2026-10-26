import { randomUUID } from 'node:crypto';
import type { OwnerEditorMaintenanceInspection } from '@assistant/firestore';
import {
  type OwnerEditorEpochCursor,
  ownerEditorEpochStateDigest,
  ownerEditorMaintenanceTargetEpochDigest,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  type OwnerEditorMaintenancePorts,
  type OwnerEditorMaintenanceRunnerMutationRequest,
  ownerEditorMaintenanceRequestDigest,
  runOwnerEditorMaintenanceRequest,
} from './owner-editor-maintenance.js';

const sha = (char: string) => char.repeat(64);
const version = (seconds: number) => ({ seconds, nanoseconds: 123_456_789 });

function fixture() {
  const ownerId = randomUUID();
  const targetEpoch = randomUUID();
  const identity = {
    sourceSHA: 'a'.repeat(40),
    project: 'assistant-project',
    database: 'assistant-production',
    installationId: 'installation-production',
    ownerId,
    agentImageDigest: `sha256:${sha('b')}`,
    agentRuntimeServiceAccount: 'agent@assistant-project.iam.gserviceaccount.com',
    webReleaseSHA: 'c'.repeat(40),
    agentReleaseSHA: 'a'.repeat(40),
    indexManifestSHA256: sha('d'),
  };
  const before: OwnerEditorMaintenanceInspection = {
    ownerId,
    ownerNativeVersion: version(10),
    cursor: null,
    epochNativeVersion: null,
    privacyGeneration: null,
    lineageDigest: sha('e'),
    lineageNativeVersion: version(8),
  };
  const unbound = {
    ...identity,
    action: 'provision-disabled' as const,
    operationId: randomUUID(),
    targetEpoch,
    expectedEpochStateDigestOrAbsent: null,
    expectedEpochNativeVersionOrAbsent: null,
    expectedOwnerNativeVersion: before.ownerNativeVersion,
    expectedPrivacyDigest: ownerEditorPrivacyDigest(null),
    expectedLineageDigest: before.lineageDigest,
    expectedLineageNativeVersion: before.lineageNativeVersion,
    preflightDigest: sha('f'),
    maintenanceDrainEvidenceDigest: sha('1'),
    checkpointEvidenceDigest: sha('2'),
  };
  const request: OwnerEditorMaintenanceRunnerMutationRequest = {
    ...unbound,
    requestDigest: ownerEditorMaintenanceRequestDigest(unbound),
  };
  const afterCursor: OwnerEditorEpochCursor = {
    ownerId,
    epoch: targetEpoch,
    ready: false,
    privacyGenerationDigest: request.expectedPrivacyDigest,
    maintenanceBinder: {
      version: 1,
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      action: request.action,
      targetEpochDigest: ownerEditorMaintenanceTargetEpochDigest(targetEpoch),
    },
  };
  const after: OwnerEditorMaintenanceInspection = {
    ...before,
    cursor: afterCursor,
    epochNativeVersion: version(11),
  };
  let inspection = before;
  const calls = { rotate: 0, indexes: 0, readiness: 0, inspectReadiness: 0 };
  const ports: OwnerEditorMaintenancePorts = {
    readFixedRuntimeIdentity: async () => identity,
    verifyIndexes: async ({ expectedManifestSha256 }) => {
      calls.indexes++;
      return { manifestSha256: expectedManifestSha256, status: 'ready' as const };
    },
    inspectReadiness: async () => {
      calls.inspectReadiness++;
      return { status: 'ready' as const };
    },
    verifyMutationReadiness: async ({ request: readinessRequest }) => {
      calls.readiness++;
      return {
        status: 'ready',
        preflightDigest: readinessRequest.preflightDigest,
        maintenanceDrainEvidenceDigest: readinessRequest.maintenanceDrainEvidenceDigest,
        checkpointEvidenceDigest: readinessRequest.checkpointEvidenceDigest,
      };
    },
    storage: {
      inspect: async () => inspection,
      rotate: async () => {
        calls.rotate++;
        inspection = after;
        return { status: 'rotated', cursor: afterCursor };
      },
    },
  };
  return {
    identity,
    before,
    after,
    request,
    ports,
    calls,
    setInspection: (value: OwnerEditorMaintenanceInspection) => {
      inspection = value;
    },
  };
}

describe('injected owner-editor maintenance runner', () => {
  it('keeps inspect read-only and redacts the raw epoch', async () => {
    const f = fixture();
    f.ports.verifyIndexes = async ({ expectedManifestSha256 }) => {
      f.calls.indexes++;
      return {
        status: 'unknown',
        manifestSha256: expectedManifestSha256,
        diagnostic: 'x'.repeat(2_000),
      };
    };
    f.ports.inspectReadiness = async () => {
      f.calls.inspectReadiness++;
      return { status: 'unknown', diagnostic: 'y'.repeat(2_000) };
    };
    const result = await runOwnerEditorMaintenanceRequest(
      { ...f.identity, action: 'inspect' },
      f.ports,
    );
    expect(result.status).toBe('inspected');
    expect(f.calls).toEqual({ rotate: 0, indexes: 1, readiness: 0, inspectReadiness: 1 });
    expect(JSON.stringify(result)).not.toContain(f.request.targetEpoch);
    expect(JSON.stringify(result).length).toBeLessThan(64 * 1024);
    expect(result.indexReadiness.diagnostic).toBeUndefined();
    expect(result.maintenanceReadiness).toMatchObject({ status: 'unknown' });
  });

  it('requires exact trusted identity, index, readiness, and original observations before rotating', async () => {
    const f = fixture();
    f.ports.verifyMutationReadiness = async ({ request: readinessRequest }) => {
      f.calls.readiness++;
      expect(Object.isFrozen(readinessRequest)).toBe(true);
      expect(Object.isFrozen(readinessRequest.expectedOwnerNativeVersion)).toBe(true);
      expect(Reflect.set(readinessRequest, 'targetEpoch', randomUUID())).toBe(false);
      return {
        status: 'ready',
        preflightDigest: readinessRequest.preflightDigest,
        maintenanceDrainEvidenceDigest: readinessRequest.maintenanceDrainEvidenceDigest,
        checkpointEvidenceDigest: readinessRequest.checkpointEvidenceDigest,
      };
    };
    const result = await runOwnerEditorMaintenanceRequest(f.request, f.ports);
    expect(result).toMatchObject({ status: 'rotated', operationDigest: f.request.requestDigest });
    expect(result.cursor?.epochDigest).toBe(
      ownerEditorMaintenanceTargetEpochDigest(f.request.targetEpoch),
    );
    expect(JSON.stringify(result)).not.toContain(f.request.targetEpoch);
    expect(f.calls).toEqual({ rotate: 1, indexes: 1, readiness: 1, inspectReadiness: 0 });
  });

  it('rejects oversized requests before invoking any trust or storage port', async () => {
    const f = fixture();
    await expect(
      runOwnerEditorMaintenanceRequest({ ...f.request, unexpected: 'x'.repeat(5_000) }, f.ports),
    ).rejects.toThrow('fixed size cap');
    expect(f.calls).toEqual({ rotate: 0, indexes: 0, readiness: 0, inspectReadiness: 0 });
  });

  it('does not dispatch a port when the run deadline expires before its queued dispatch', async () => {
    const f = fixture();
    vi.useFakeTimers();
    let dispatches = 0;
    const queueMicrotask = globalThis.queueMicrotask.bind(globalThis);
    const queueSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      dispatches++;
      if (dispatches === 5) vi.setSystemTime(Date.now() + 60_001);
      queueMicrotask(callback);
    });
    try {
      const pending = runOwnerEditorMaintenanceRequest(f.request, f.ports);
      await vi.runAllTicks();
      await expect(pending).rejects.toThrow('outcome is unknown');
      expect(dispatches).toBe(5);
      expect(f.calls.rotate).toBe(0);
    } finally {
      queueSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('maps secret-bearing and oversized port failures to fixed safe errors', async () => {
    const secret = `${randomUUID()} ${'private-detail-'.repeat(400)}`;
    const expectFixedFailure = async (promise: Promise<unknown>, message: string) => {
      let caught: unknown;
      try {
        await promise;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(message);
      expect(String(caught)).toBe(`Error: ${message}`);
      expect(JSON.stringify(caught)).not.toContain(secret);
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    };

    const identityFailure = fixture();
    identityFailure.ports.readFixedRuntimeIdentity = async () => {
      throw new Error(secret);
    };
    await expectFixedFailure(
      runOwnerEditorMaintenanceRequest(identityFailure.request, identityFailure.ports),
      'Fixed-job identity verification is unavailable',
    );

    const inspectionFailure = fixture();
    inspectionFailure.ports.storage.inspect = async () => {
      throw new Error(secret);
    };
    await expectFixedFailure(
      runOwnerEditorMaintenanceRequest(inspectionFailure.request, inspectionFailure.ports),
      'Owner/privacy/epoch inspection is unavailable',
    );

    const indexFailure = fixture();
    indexFailure.ports.verifyIndexes = async () => {
      throw new Error(secret);
    };
    await expectFixedFailure(
      runOwnerEditorMaintenanceRequest(indexFailure.request, indexFailure.ports),
      'Approved index verification is unavailable',
    );

    const readinessFailure = fixture();
    readinessFailure.ports.verifyMutationReadiness = async () => {
      throw new Error(secret);
    };
    await expectFixedFailure(
      runOwnerEditorMaintenanceRequest(readinessFailure.request, readinessFailure.ports),
      'External drain/checkpoint verification is unavailable',
    );
  });

  it('binds the full runner envelope, including identity and verified evidence pins', () => {
    const f = fixture();
    const { requestDigest: _requestDigest, ...binding } = f.request;
    expect(ownerEditorMaintenanceRequestDigest({ ...binding, project: 'other-project' })).not.toBe(
      f.request.requestDigest,
    );
    expect(
      ownerEditorMaintenanceRequestDigest({ ...binding, checkpointEvidenceDigest: sha('9') }),
    ).not.toBe(f.request.requestDigest);
  });

  it('fails closed when fixed-job identity or approved index readiness differs', async () => {
    const identityMismatch = fixture();
    identityMismatch.ports.readFixedRuntimeIdentity = async () => ({
      ...identityMismatch.identity,
      project: 'other-project',
    });
    await expect(
      runOwnerEditorMaintenanceRequest(identityMismatch.request, identityMismatch.ports),
    ).rejects.toThrow('fixed-job identity');
    expect(identityMismatch.calls).toEqual({
      rotate: 0,
      indexes: 0,
      readiness: 0,
      inspectReadiness: 0,
    });

    const indexMismatch = fixture();
    indexMismatch.ports.verifyIndexes = async () => ({
      manifestSha256: sha('0'),
      status: 'ready' as const,
    });
    await expect(
      runOwnerEditorMaintenanceRequest(indexMismatch.request, indexMismatch.ports),
    ).rejects.toThrow('Approved indexes');
    expect(indexMismatch.calls.rotate).toBe(0);
    expect(indexMismatch.calls.readiness).toBe(0);
  });

  it('resolves a lost rotation response only from the exact operation binder readback', async () => {
    const f = fixture();
    f.ports.storage.rotate = async () => {
      f.setInspection(f.after);
      throw new Error('simulated lost acknowledgement');
    };
    const result = await runOwnerEditorMaintenanceRequest(f.request, f.ports);
    expect(result.status).toBe('replayed');
    expect(result.cursor?.epochDigest).toBe(
      ownerEditorMaintenanceTargetEpochDigest(f.request.targetEpoch),
    );
  });

  it('bounds a never-settling native rotation and keeps the hold when readback is not exact', async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      f.ports.storage.rotate = async () => {
        f.calls.rotate++;
        return new Promise<never>(() => {});
      };
      const pending = runOwnerEditorMaintenanceRequest(f.request, f.ports);
      const rejected = expect(pending).rejects.toThrow('outcome is unknown');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(f.calls.rotate).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the same original request from its postwrite binder without checking stale epoch version', async () => {
    const f = fixture();
    await runOwnerEditorMaintenanceRequest(f.request, f.ports);
    const result = await runOwnerEditorMaintenanceRequest(f.request, f.ports);
    expect(result.status).toBe('replayed');
    expect(f.calls.rotate).toBe(1);
    expect(f.calls.readiness).toBe(2);
    expect(f.calls.indexes).toBe(2);
  });

  it('does not return a stale replay snapshot if privacy changes during external readiness checks', async () => {
    const f = fixture();
    await runOwnerEditorMaintenanceRequest(f.request, f.ports);
    const verify = f.ports.verifyMutationReadiness;
    f.ports.verifyMutationReadiness = async (input) => {
      const proof = await verify(input);
      f.setInspection({ ...f.after, privacyGeneration: 'a-new-privacy-generation' });
      return proof;
    };
    await expect(runOwnerEditorMaintenanceRequest(f.request, f.ports)).rejects.toThrow(
      'outcome is unknown',
    );
    expect(f.calls.rotate).toBe(1);
  });

  it.each(['owner', 'privacy', 'lineage'] as const)(
    'retains the hold when the original committed operation has changed %s guards',
    async (changed) => {
      const f = fixture();
      await runOwnerEditorMaintenanceRequest(f.request, f.ports);
      f.setInspection({
        ...f.after,
        ...(changed === 'owner' ? { ownerNativeVersion: version(12) } : {}),
        ...(changed === 'privacy' ? { privacyGeneration: 'new-privacy' } : {}),
        ...(changed === 'lineage' ? { lineageNativeVersion: version(12) } : {}),
      });
      await expect(runOwnerEditorMaintenanceRequest(f.request, f.ports)).rejects.toThrow(
        'outcome is unknown',
      );
      expect(f.calls.rotate).toBe(1);
    },
  );

  it('allows disable to rotate an existing disabled epoch and retire its prior claim scope', async () => {
    const f = fixture();
    const priorCursor: OwnerEditorEpochCursor = {
      ownerId: f.request.ownerId,
      epoch: randomUUID(),
      ready: false,
      privacyGenerationDigest: f.request.expectedPrivacyDigest,
    };
    const priorInspection: OwnerEditorMaintenanceInspection = {
      ...f.before,
      cursor: priorCursor,
      epochNativeVersion: version(9),
    };
    const targetEpoch = randomUUID();
    const unbound = {
      ...f.identity,
      action: 'disable' as const,
      operationId: randomUUID(),
      targetEpoch,
      expectedEpochStateDigestOrAbsent: ownerEditorEpochStateDigest(priorCursor),
      expectedEpochNativeVersionOrAbsent: priorInspection.epochNativeVersion,
      expectedOwnerNativeVersion: priorInspection.ownerNativeVersion,
      expectedPrivacyDigest: ownerEditorPrivacyDigest(null),
      expectedLineageDigest: priorInspection.lineageDigest,
      expectedLineageNativeVersion: priorInspection.lineageNativeVersion,
      preflightDigest: sha('3'),
      maintenanceDrainEvidenceDigest: sha('4'),
      checkpointEvidenceDigest: sha('5'),
    };
    const request: OwnerEditorMaintenanceRunnerMutationRequest = {
      ...unbound,
      requestDigest: ownerEditorMaintenanceRequestDigest(unbound),
    };
    const disabledCursor: OwnerEditorEpochCursor = {
      ownerId: request.ownerId,
      epoch: targetEpoch,
      ready: false,
      privacyGenerationDigest: request.expectedPrivacyDigest,
      maintenanceBinder: {
        version: 1,
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        action: request.action,
        targetEpochDigest: ownerEditorMaintenanceTargetEpochDigest(targetEpoch),
      },
    };
    let inspection = priorInspection;
    f.ports.storage.inspect = async () => inspection;
    f.ports.storage.rotate = async () => {
      inspection = { ...priorInspection, cursor: disabledCursor, epochNativeVersion: version(10) };
      return { status: 'rotated', cursor: disabledCursor };
    };
    const result = await runOwnerEditorMaintenanceRequest(request, f.ports);
    expect(result.status).toBe('rotated');
    expect(result.cursor?.ready).toBe(false);
    expect(result.cursor?.epochDigest).toBe(ownerEditorMaintenanceTargetEpochDigest(targetEpoch));
  });

  it('retains the hold when the postwrite binder does not match the original request', async () => {
    const f = fixture();
    const wrongBinder = {
      ...f.after,
      cursor: {
        ...f.after.cursor!,
        maintenanceBinder: { ...f.after.cursor!.maintenanceBinder!, operationId: randomUUID() },
      },
    };
    f.ports.storage.rotate = async () => {
      f.setInspection(wrongBinder);
      throw new Error('simulated lost acknowledgement');
    };
    await expect(runOwnerEditorMaintenanceRequest(f.request, f.ports)).rejects.toThrow(
      'outcome is unknown',
    );
  });

  it('does not refresh stale native observations or proceed when readiness evidence differs', async () => {
    const f = fixture();
    const staleCursor = { ...f.after.cursor!, epoch: randomUUID() };
    delete (staleCursor as Partial<OwnerEditorEpochCursor>).maintenanceBinder;
    f.setInspection({ ...f.before, epochNativeVersion: version(9), cursor: staleCursor });
    await expect(runOwnerEditorMaintenanceRequest(f.request, f.ports)).rejects.toThrow(
      'outcome is unknown',
    );
    expect(f.calls.rotate).toBe(0);

    const g = fixture();
    g.ports.verifyMutationReadiness = vi.fn(async () => ({
      status: 'ready' as const,
      preflightDigest: sha('0'),
      maintenanceDrainEvidenceDigest: g.request.maintenanceDrainEvidenceDigest,
      checkpointEvidenceDigest: g.request.checkpointEvidenceDigest,
    }));
    await expect(runOwnerEditorMaintenanceRequest(g.request, g.ports)).rejects.toThrow(
      'External drain/checkpoint verification is unavailable',
    );
    expect(g.calls.rotate).toBe(0);
  });
});
