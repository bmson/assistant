import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  type Basic5CiCaseResult,
  type Basic5CiDirectChildHandle,
  type Basic5CiEvidence,
  Basic5CiHold,
  type Basic5CiOps,
  type Basic5CiPreflight,
  type Basic5CiQuiescence,
  type Basic5CiTarget,
  ownedSessionEnrollmentOrder,
  parseLinuxListenTable,
  runBasic5CiAcceptance,
  runBasic5CiReadOnlyMetadata,
  verifyDirectChildBootstrap,
} from './basic5-ci-acceptance.js';

const target: Basic5CiTarget = {
  databaseUrl: 'postgres://synthetic@127.0.0.1:5432/assistant_0123456789abcdef01234567_test',
  databaseName: 'assistant_0123456789abcdef01234567_test',
  token: '0123456789abcdef01234567',
};
const preflight: Basic5CiPreflight = {
  sourceCommit: 'a'.repeat(40),
  sourceWebTree: 'b'.repeat(40),
  nodeVersion: 'v26.0.0',
  imageOS: 'ubuntu24',
  imageVersion: '20261101.1',
  chromeVersion: '144.0.0.0',
  postgresServerVersionNum: 170000,
  buildId: 'build-1',
  serverSha256: 'c'.repeat(64),
  closureSha256: 'd'.repeat(64),
  closureEntryCount: 100,
  closureFileCount: 80,
  closureSymlinkCount: 20,
  closureFileBytes: 1_000_000,
  staticPresent: true,
  staticFileCount: 8,
  publicPresent: true,
  publicFileCount: 4,
  traceManifestCount: 2,
  traceManifestBytes: 4_000,
  traceManifestSha256: 'e'.repeat(64),
  traceStatus: 'complete',
  traceReferenceCount: 9,
  resolvedCheckoutReferenceCount: 1,
  matchedClosureContentCount: 8,
  unmatchedReferenceCount: 0,
  buildExecutionAttribution: 'unknown-cache-may-have-reused-output',
  provenanceLimitations: ['cache attribution unknown'],
};

function validEvidence(): Basic5CiEvidence {
  const operationIds = [1, 2, 3, 4].map(
    (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
  );
  return {
    result: 'passed',
    standalone: {
      sourceCommit: preflight.sourceCommit,
      buildId: preflight.buildId,
      serverSha256: preflight.serverSha256,
    },
    executionEnvironment: {
      platform: 'linux',
      nodeVersion: preflight.nodeVersion,
      browserChannel: 'chrome',
      browserVersion: preflight.chromeVersion,
      postgresServerVersionNum: 170000,
    },
    fixture: {
      databaseTargetDigest: createHash('sha256')
        .update(target.databaseName)
        .digest('hex')
        .slice(0, 24),
      ownerId: '10000000-0000-4000-8000-000000000001',
      epochPrivacyMatchedReady: true,
      baseline: {
        contactIds: [
          '20000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
        ],
        entityIds: ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'],
        noteId: '40000000-0000-4000-8000-000000000001',
        noteHash: 'e'.repeat(64),
      },
      generatedOperationIds: operationIds,
    },
    receipts: [
      {
        command: 'update_person_identity',
        ids: { contactId: '20000000-0000-4000-8000-000000000001' },
      },
      {
        command: 'add_family_relationship',
        ids: {
          relationId: '50000000-0000-4000-8000-000000000001',
          memoryId: '60000000-0000-4000-8000-000000000001',
        },
      },
      {
        command: 'correct_owner_family_relationship',
        ids: {
          previousRelationId: '50000000-0000-4000-8000-000000000001',
          relationId: '50000000-0000-4000-8000-000000000002',
          memoryId: '60000000-0000-4000-8000-000000000002',
        },
      },
      {
        command: 'correct_owner_memory',
        ids: { memoryId: '40000000-0000-4000-8000-000000000001' },
      },
    ].map(({ command, ids }, index) => {
      const operationId = operationIds[index];
      if (!operationId) throw new Error('Missing fake operation ID');
      return {
        authority: 'operation_receipt',
        command,
        operationId,
        requestHash: `${index}`.repeat(64),
        statusVersion: index + 1,
        outcome: 'saved',
        ids: ids as unknown as Record<string, string>,
      };
    }),
    durableReadbacks: {
      identity: true,
      familyAdd: true,
      familyCorrection: true,
      noteCorrection: true,
    },
    counts: {
      readinessAttempts: 8,
      pageNavigations: 6,
      authenticatedPageNavigations: 6,
      browserHttpRequests: 24,
      browserPageHttpRequests: 23,
      anonymousApiProbeRequests: 1,
      pageApiMutationRequests: 4,
      applyPosts: 4,
      ownerEditorPostCount: 4,
      ownerApplyRequests: 4,
      recoveryGets: 0,
      recoveryRequests: 0,
      embeddingRequests: 3,
      fixtureModelCalls: 3,
      foreignModelCalls: 0,
      providerRequests: {
        localEmbeddingHttpRequests: 3,
        fixtureModelCallRows: 3,
        nonFixtureModelCallRows: 0,
      },
    },
    cleanup: {
      browserClosed: true,
      standaloneProcessGroupExited: true,
      embeddingServerClosed: true,
      databasePoolClosed: true,
      temporaryHomeRemoved: true,
    },
    externalCleanupSupervisorRequired: true,
    standardTestWrapperCleanupIsUnconditional: true,
    testFailure: null,
    cleanupFailure: null,
  };
}

class FakeOps implements Basic5CiOps {
  time = 0;
  events: string[] = [];
  caseResult: Basic5CiCaseResult = {
    exitCode: 0,
    total: 1,
    passed: 1,
    skipped: 0,
    failed: 0,
    evidence: validEvidence(),
  };
  quiescence: Basic5CiQuiescence = {
    known: true,
    registeredRoles: ['fixture-worker', 'web', 'browser', 'embedding'],
    liveOwnedProcesses: 0,
    liveOwnedListeners: 0,
    unknownProcesses: 0,
    fixtureRegistryValid: true,
  };
  absent = true;
  failCleanup = false;
  prepareAdvanceMs = 0;
  prepareThrows = false;
  preflightError?: Basic5CiHold;
  caseThrows = false;
  neverResolveCase = false;
  uninterruptibleCase = false;
  resolveCaseAfterAbort = false;
  writtenReceipt?: Record<string, unknown>;
  now(): number {
    return this.time;
  }
  async preflight(deadline: number, _signal: AbortSignal): Promise<Basic5CiPreflight> {
    this.events.push('preflight');
    expect(deadline).toBe(20_000);
    if (this.preflightError) throw this.preflightError;
    return preflight;
  }
  async prepareFreshTarget(deadline: number, _signal: AbortSignal): Promise<Basic5CiTarget> {
    this.events.push('prepare');
    expect(deadline).toBe(130_000);
    this.time += this.prepareAdvanceMs;
    if (this.prepareThrows) throw new Error('redacted prepare error');
    return target;
  }
  async runExactCase(
    _target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Basic5CiCaseResult> {
    this.events.push('case');
    expect(deadline).toBe(310_000);
    if (this.caseThrows) throw new Error('redacted case error');
    if (this.neverResolveCase && this.uninterruptibleCase) return new Promise(() => {});
    if (this.resolveCaseAfterAbort)
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => setTimeout(() => resolve(this.caseResult), 0), {
          once: true,
        });
      });
    if (this.neverResolveCase)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Basic5CiHold('fake_cancelled')), {
          once: true,
        });
      });
    return this.caseResult;
  }
  async quiesceApplication(deadline: number, _signal: AbortSignal): Promise<Basic5CiQuiescence> {
    this.events.push('quiesce');
    expect(deadline).toBe(400_000);
    return this.quiescence;
  }
  async cleanupExactTarget(
    _target: Basic5CiTarget,
    deadline: number,
    _signal: AbortSignal,
  ): Promise<void> {
    this.events.push('cleanup');
    expect(deadline).toBe(400_000);
    if (this.failCleanup) throw new Error('redacted cleanup error');
  }
  async verifyTargetAbsent(
    _target: Basic5CiTarget,
    _deadline: number,
    _signal: AbortSignal,
  ): Promise<boolean> {
    this.events.push('verify-absent');
    return this.absent;
  }
  async writeContentFreeReceipt(
    receipt: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<void> {
    this.events.push('receipt');
    this.writtenReceipt = receipt;
  }
}

class FakeDirectChild extends EventEmitter implements Basic5CiDirectChildHandle {
  pid: number | undefined = 88;
  stdout: unknown = {};
  stderr: unknown = {};
  killCalls = 0;
  closed = false;

  kill(): boolean {
    this.killCalls += 1;
    queueMicrotask(() => {
      this.closed = true;
      this.emit('close', null, 'SIGKILL');
    });
    return true;
  }
}

describe('one-shot BASIC5 CI controller', () => {
  it('retains bounded standalone diagnostic checks on a preallocation hold', async () => {
    const ops = new FakeOps();
    const diagnostic = {
      checks: {
        sourceCommitMatches: true,
        sourceWebTreeMatches: true,
        nodeVersionMatches: true,
        imageOSMatches: true,
        imageVersionMatches: true,
        buildIdPresent: true,
        serverSha256Valid: true,
        closureSha256Valid: true,
        tracesComplete: false,
        unmatchedTraceReferencesZero: false,
        limitationsArray: true,
        limitationsCountBounded: true,
        limitationsItemsBounded: true,
        closureEntryCountPositive: true,
        closureFileCountPositive: true,
        closureSymlinkCountValid: true,
        closureFileBytesPositive: true,
        staticFileCountValid: true,
        publicFileCountValid: true,
        traceManifestCountValid: true,
        traceManifestBytesValid: true,
        traceReferenceCountValid: true,
        resolvedTraceReferenceCountValid: true,
        matchedTraceContentCountValid: true,
        unmatchedTraceReferenceCountValid: true,
      },
      observed: {
        traceStatus: 'incomplete' as const,
        closureEntryCount: 100,
        closureFileCount: 80,
        closureSymlinkCount: 20,
        closureFileBytes: 2 * 1024 * 1024 * 1024,
        staticFileCount: 8,
        publicFileCount: 4,
        traceManifestCount: 2,
        traceManifestBytes: 4_000,
        traceReferenceCount: 9,
        resolvedCheckoutReferenceCount: 9,
        matchedClosureContentCount: 8,
        unmatchedReferenceCount: 1,
      },
    };
    ops.preflightError = new Basic5CiHold(
      'standalone_build_provenance_incomplete',
      true,
      diagnostic,
    );

    const result = await runBasic5CiAcceptance(ops);

    expect(result.errorCode).toBe('standalone_build_provenance_incomplete');
    expect(result.targetStatus).toBe('not_allocated');
    expect(result.standaloneBuildDiagnostic).toEqual(diagnostic);
    expect(ops.events).toEqual(['preflight', 'receipt']);
  });

  it('parses only Linux LISTEN rows and holds on malformed listener census', () => {
    const tcp = 'sl local_address rem_address st\n0: 0100007F:1F90 00000000:0000 0A';
    const tcp6 =
      'sl local_address rem_address st\n0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A';
    expect([...parseLinuxListenTable(tcp, tcp6).values()].sort()).toEqual([8080, 8081]);
    expect(
      parseLinuxListenTable(
        'sl local_address rem_address st\n0: 0100007F:1F90 00000000:0000 01',
        tcp6,
      ).size,
    ).toBe(1);
    expect(() => parseLinuxListenTable('missing', tcp6)).toThrow(Basic5CiHold);
  });

  it('enrolls owned session children independent of /proc PID ordering', () => {
    const snapshot = new Map([
      [80, { pid: 80, ppid: 70, pgid: 70, sid: 60, startTimeTicks: '3' }],
      [70, { pid: 70, ppid: 60, pgid: 70, sid: 60, startTimeTicks: '2' }],
      [60, { pid: 60, ppid: 1, pgid: 60, sid: 60, startTimeTicks: '1' }],
    ]);
    expect(ownedSessionEnrollmentOrder(snapshot, 60, new Set([60]))).toEqual([70, 80]);
    const orphan = new Map(snapshot);
    orphan.set(90, { pid: 90, ppid: 999, pgid: 70, sid: 60, startTimeTicks: '4' });
    expect(() => ownedSessionEnrollmentOrder(orphan, 60, new Set([60]))).toThrow(Basic5CiHold);
  });

  it('accepts a fast read-only metadata exit without a process-identity race', async () => {
    const execute = (
      _command: string,
      _args: string[],
      options: { timeout: number; maxBuffer: number },
      callback: (error: unknown, stdout: Buffer, stderr: Buffer) => void,
    ) => {
      expect(options.timeout).toBe(5_000);
      expect(options.maxBuffer).toBe(64 * 1024);
      callback(null, Buffer.from('deadbeef\n'), Buffer.alloc(0));
      return {};
    };
    const result = await runBasic5CiReadOnlyMetadata(
      'git',
      ['rev-parse', 'HEAD'],
      {
        cwd: '/synthetic/repo',
        env: {},
        encoding: 'buffer',
        maxBuffer: 1,
        timeout: 1,
        killSignal: 'SIGKILL',
      },
      10_000,
      () => 0,
      execute,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('deadbeef\n');
    let invoked = false;
    await expect(
      runBasic5CiReadOnlyMetadata(
        'git',
        ['reset', '--hard'],
        {
          cwd: '/synthetic/repo',
          env: {},
          encoding: 'buffer',
          maxBuffer: 1,
          timeout: 1,
          killSignal: 'SIGKILL',
        },
        10_000,
        () => 0,
        (_command, _args, _options, callback) => {
          invoked = true;
          callback(null, Buffer.alloc(0), Buffer.alloc(0));
          return {};
        },
      ),
    ).rejects.toThrow(Basic5CiHold);
    expect(invoked).toBe(false);
  });

  it('settles only the direct child when identity or output streams are missing', async () => {
    const identityChild = new FakeDirectChild();
    const identityClosed = new Promise<void>((resolve) =>
      identityChild.once('close', () => resolve()),
    );
    await expect(
      verifyDirectChildBootstrap(identityChild, 1, async () => undefined, identityClosed),
    ).rejects.toMatchObject({ operationSettled: false });
    expect(identityChild.killCalls).toBe(1);
    expect(identityChild.closed).toBe(true);

    const streamChild = new FakeDirectChild();
    streamChild.stderr = undefined;
    const streamClosed = new Promise<void>((resolve) => streamChild.once('close', () => resolve()));
    let identityRead = false;
    await expect(
      verifyDirectChildBootstrap(
        streamChild,
        1,
        async () => {
          identityRead = true;
          return undefined;
        },
        streamClosed,
      ),
    ).rejects.toMatchObject({ operationSettled: false });
    expect(streamChild.killCalls).toBe(1);
    expect(streamChild.closed).toBe(true);
    expect(identityRead).toBe(false);
  });

  it('runs one case, closes every registered role, then removes the exact target', async () => {
    const ops = new FakeOps();
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('passed');
    expect(result.cleanupComplete).toBe(true);
    expect(result.targetStatus).toBe('removed');
    expect(result.controllerScratchStatus).toBe('retained');
    const savedReceipts = ops.writtenReceipt?.receipts as Array<Record<string, unknown>>;
    expect(savedReceipts[1]?.ids).toMatchObject({
      relationId: '50000000-0000-4000-8000-000000000001',
    });
    expect(savedReceipts[2]?.ids).toMatchObject({
      previousRelationId: '50000000-0000-4000-8000-000000000001',
      relationId: '50000000-0000-4000-8000-000000000002',
    });
    expect(savedReceipts[3]?.ids).toMatchObject({
      memoryId: '40000000-0000-4000-8000-000000000001',
    });
    expect(ops.events).toEqual([
      'preflight',
      'prepare',
      'case',
      'quiesce',
      'cleanup',
      'verify-absent',
      'receipt',
    ]);
  });

  it('quiesces after a failed case but retains the database without retry or cleanup', async () => {
    const ops = new FakeOps();
    ops.caseResult = { ...ops.caseResult, exitCode: 1, failed: 1, passed: 0 };
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(result.targetStatus).toBe('retained');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('retains the target when process, listener, or census closure is unknown', async () => {
    const ops = new FakeOps();
    ops.quiescence = { ...ops.quiescence, known: false };
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('refuses to start after the 130-second ceiling and retains the target', async () => {
    const ops = new FakeOps();
    ops.prepareAdvanceMs = 130_001;
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(ops.events).toEqual(['preflight', 'prepare', 'quiesce', 'receipt']);
  });

  it('runs process teardown after an interrupted target-preparation phase and keeps target state unknown', async () => {
    const ops = new FakeOps();
    ops.prepareThrows = true;
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(result.targetStatus).toBe('unknown');
    expect(result.targetRetained).toBeNull();
    expect(ops.events).toEqual(['preflight', 'prepare', 'quiesce', 'receipt']);
  });

  it('retains when cleanup or exact-target absence cannot be verified', async () => {
    const cleanupOps = new FakeOps();
    cleanupOps.failCleanup = true;
    const cleanup = await runBasic5CiAcceptance(cleanupOps);
    expect(cleanup.result).toBe('hold');
    expect(cleanupOps.events).toEqual([
      'preflight',
      'prepare',
      'case',
      'quiesce',
      'cleanup',
      'receipt',
    ]);
    const absentOps = new FakeOps();
    absentOps.absent = false;
    const absent = await runBasic5CiAcceptance(absentOps);
    expect(absent.result).toBe('hold');
    expect(absent.cleanupComplete).toBe(false);
  });

  it('requires zero skips and the exact four save receipts', async () => {
    const ops = new FakeOps();
    ops.caseResult = { ...ops.caseResult, skipped: 1 };
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('retains the target when receipt lineage or browser request counters diverge', async () => {
    const lineageOps = new FakeOps();
    const correctionReceipt = lineageOps.caseResult.evidence.receipts[2];
    if (!correctionReceipt?.ids) throw new Error('Missing fake correction receipt IDs');
    correctionReceipt.ids.previousRelationId = '50000000-0000-4000-8000-000000000099';
    const lineage = await runBasic5CiAcceptance(lineageOps);
    expect(lineage.result).toBe('hold');
    expect(lineageOps.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);

    const counterOps = new FakeOps();
    counterOps.caseResult.evidence.counts.browserPageHttpRequests = 99;
    const counters = await runBasic5CiAcceptance(counterOps);
    expect(counters.result).toBe('hold');
    expect(counterOps.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('races a never-resolving test phase against its deadline and reserves teardown', async () => {
    const ops = new FakeOps();
    ops.neverResolveCase = true;
    const timers = {
      schedule(callback: () => void, delayMs: number) {
        void delayMs;
        return setTimeout(callback, 0);
      },
      cancel(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer);
      },
    };
    const result = await runBasic5CiAcceptance(ops, timers);
    expect(result.result).toBe('hold');
    expect(result.errorCode).toBe('test_deadline');
    expect(result.targetStatus).toBe('retained');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('rejects a phase that resolves after its deadline was already fired', async () => {
    const ops = new FakeOps();
    ops.resolveCaseAfterAbort = true;
    const timers = {
      schedule(callback: () => void) {
        return setTimeout(callback, 0);
      },
      cancel(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer);
      },
    };
    const result = await runBasic5CiAcceptance(ops, timers);
    expect(result.result).toBe('hold');
    expect(result.errorCode).toBe('test_deadline');
    expect(result.targetStatus).toBe('retained');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('skips quiescence and database cleanup while a timed-out phase ignores cancellation', async () => {
    const ops = new FakeOps();
    ops.neverResolveCase = true;
    ops.uninterruptibleCase = true;
    const timers = {
      schedule(callback: () => void) {
        return setTimeout(callback, 0);
      },
      cancel(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer);
      },
    };
    const result = await runBasic5CiAcceptance(ops, timers);
    expect(result.result).toBe('hold');
    expect(result.operationSettled).toBe(false);
    expect(result.quiescenceStatus).toBe('not_attempted_pending_phase_operation');
    expect(result.targetStatus).toBe('retained');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'receipt']);
  });

  it('rejects unexpected nested evidence before any untrusted fields reach the final receipt', async () => {
    const ops = new FakeOps();
    ops.caseResult.evidence.counts.sensitiveNote = 'fixture note text';
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(JSON.stringify(ops.writtenReceipt)).not.toContain('fixture note text');
    expect(ops.writtenReceipt?.counts).toBeUndefined();
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });
});
