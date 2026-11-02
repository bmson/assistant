import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  assertBasic5CiUtilityChildSucceeded,
  assertBasic5CiWorkflowAdmission,
  type Basic5CiCaseEntryDiagnostic,
  type Basic5CiCaseResult,
  type Basic5CiDirectChildHandle,
  type Basic5CiEvidence,
  Basic5CiHold,
  type Basic5CiOps,
  type Basic5CiPreflight,
  type Basic5CiPreparationDiagnostic,
  type Basic5CiProcessSnapshot,
  type Basic5CiQuiescence,
  type Basic5CiTarget,
  type Basic5CiUtilityChildTestDriver,
  combineBasic5CiPreparationFailures,
  holdForBasic5CiUtilityBootstrapFailure,
  observeBasic5CiChromeVersion,
  ownedSessionEnrollmentOrder,
  parseLinuxListenTable,
  RealBasic5CiOps,
  runBasic5CiAcceptance,
  runBasic5CiCaseEntryStep,
  runBasic5CiPreparationStep,
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
  chromeVersionDiagnostic: {
    status: 'accepted',
    exitCode: 0,
    stdoutBytes: 24,
    stderrBytes: 0,
  },
  postgresServerVersionNum: 170000,
  utilityChildDiagnostics: [],
  workflowContext: {
    event: 'push',
    ref: 'refs/heads/main',
    runAttempt: 1,
    frozenLockfileInstallAndBuildSucceeded: true,
    frozenLockfileBuildBasis: 'ordered_ci_steps_completed_before_acceptance',
    workflowSha: 'a'.repeat(40),
    lockfileSha256: 'f'.repeat(64),
  },
  requiredArtifactIdentity: {
    buildId: 'build-1',
    buildIdSha256: 'a'.repeat(64),
    serverSha256: 'c'.repeat(64),
    runtimeInventorySha256: 'd'.repeat(64),
    runtimeInventoryEntryCount: 100,
    runtimeInventoryFileCount: 80,
    runtimeInventorySymlinkCount: 20,
    runtimeInventoryBytes: 1_000_000,
    staticAssets: { present: true, fileCount: 8, sha256: 'b'.repeat(64) },
    publicAssets: { present: true, fileCount: 4, sha256: 'e'.repeat(64) },
  },
  diagnosticTraceCompleteness: {
    scope: 'apps/web/.next/server',
    collection: 'not_requested',
    status: 'not_collected',
    manifestCount: null,
    manifestBytes: null,
    manifestSha256: null,
    referenceCount: null,
    resolvedCheckoutReferenceCount: null,
    matchedClosureContentCount: null,
    unmatchedReferenceCount: null,
  },
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
      buildId: preflight.requiredArtifactIdentity.buildId,
      serverSha256: preflight.requiredArtifactIdentity.serverSha256,
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
  neverResolvePreparation = false;
  preparationStage?: Basic5CiPreparationDiagnostic['stage'];
  reportPreparationStage = true;
  preflightError?: Basic5CiHold;
  preflightValue = preflight;
  preparationFailure?: { stage: Basic5CiPreparationDiagnostic['stage']; error: unknown };
  caseEntryFailure?: { stage: Basic5CiCaseEntryDiagnostic['stage']; error: unknown };
  caseEntryStage?: Basic5CiCaseEntryDiagnostic['stage'];
  reportCaseEntryStage = true;
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
    return this.preflightValue;
  }
  async prepareFreshTarget(deadline: number, _signal: AbortSignal): Promise<Basic5CiTarget> {
    this.events.push('prepare');
    expect(deadline).toBe(130_000);
    this.time += this.prepareAdvanceMs;
    if (this.neverResolvePreparation)
      return runBasic5CiPreparationStep(
        this.preparationStage ?? 'target_database_creation',
        'fake_prepare_failed',
        () => new Promise<Basic5CiTarget>(() => {}),
      );
    if (this.preparationFailure) this.preparationStage = this.preparationFailure.stage;
    if (this.preparationFailure)
      await runBasic5CiPreparationStep(
        this.preparationFailure.stage,
        'fake_preparation_failed',
        () => {
          throw this.preparationFailure?.error;
        },
      );
    if (this.prepareThrows) throw new Error('redacted prepare error');
    return target;
  }
  currentPreparationStage(): Basic5CiPreparationDiagnostic['stage'] | undefined {
    return this.reportPreparationStage ? this.preparationStage : undefined;
  }
  async runExactCase(
    _target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Basic5CiCaseResult> {
    this.events.push('case');
    expect(deadline).toBe(310_000);
    if (this.caseEntryFailure) {
      this.caseEntryStage = this.caseEntryFailure.stage;
      await runBasic5CiCaseEntryStep(this.caseEntryFailure.stage, 'fake_case_entry_failed', () => {
        throw this.caseEntryFailure?.error;
      });
    }
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
  currentCaseEntryStage(): Basic5CiCaseEntryDiagnostic['stage'] | undefined {
    return this.reportCaseEntryStage ? this.caseEntryStage : undefined;
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
  stdout: unknown = new EventEmitter();
  stderr: unknown = new EventEmitter();
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
  function utilityChildDriver(
    child: FakeDirectChild,
    options: {
      readSnapshot?: () => Promise<Map<number, Basic5CiProcessSnapshot>>;
      readIdentity?: (pid: number) => Promise<unknown>;
      now?: () => number;
    } = {},
  ): Basic5CiUtilityChildTestDriver {
    const rootIdentity = {
      pid: 88,
      ppid: process.pid,
      pgid: 88,
      sid: 88,
      startTimeTicks: '1',
      exe: '/synthetic/node',
    };
    const proof = {
      BASIC5_CI_CHROME_EXECUTABLE: '/synthetic/chrome',
      readBasic5LinuxProcessSnapshot: options.readSnapshot ?? (async () => new Map()),
      readBasic5LinuxProcessIdentity:
        options.readIdentity ?? (async (pid: number) => (pid === 88 ? rootIdentity : undefined)),
      readBasic5CiProcessRegistry: async () => [],
      assertBasic5CiProcessRegistryComplete: () => undefined,
      assertBasic5CiProcessClosure: () => undefined,
    } as unknown as Basic5CiUtilityChildTestDriver['proof'];
    return {
      spawn: (() => child) as unknown as Basic5CiUtilityChildTestDriver['spawn'],
      proof,
      now: options.now ?? (() => 1),
      sleep: async () => undefined,
      killProcess: () => undefined,
    };
  }

  const censusRoot = {
    pid: 88,
    ppid: process.pid,
    pgid: 88,
    sid: 88,
    startTimeTicks: '1',
    exe: '/synthetic/node',
  };
  const censusChild = { ...censusRoot, pid: 90, ppid: 88, startTimeTicks: '2' };
  const censusSnapshot = (...rows: Basic5CiProcessSnapshot[]) =>
    new Map(rows.map((row) => [row.pid, row]));

  async function censusSequence(
    snapshots: Array<Map<number, Basic5CiProcessSnapshot> | Error>,
    readIdentity: (pid: number) => Promise<typeof censusRoot | undefined>,
  ) {
    const child = new FakeDirectChild();
    const signals: number[] = [];
    let snapshotReads = 0;
    const driver = utilityChildDriver(child, {
      readSnapshot: async () => {
        const next = snapshots[snapshotReads++];
        if (!next) throw new Error('Unexpected extra census');
        if (next instanceof Error) throw next;
        return next;
      },
      readIdentity,
    });
    driver.sleep = async () => {
      child.emit('close', 0, null);
    };
    driver.killProcess = (pid) => {
      signals.push(pid);
    };
    const ops = new RealBasic5CiOps(driver);
    let result: Awaited<ReturnType<typeof ops.runUtilityChild>> | undefined;
    let error: unknown;
    try {
      result = await ops.runUtilityChild(
        '/synthetic/node',
        [],
        {},
        10_000,
        'migrate',
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    } finally {
      ops.dispose();
    }
    const enrolled = [
      ...(ops as unknown as { ownedProcesses: Map<number, unknown> }).ownedProcesses.keys(),
    ];
    return { result, error, snapshotReads, signals, enrolled };
  }

  it('reconciles one vanished new child and still requires independent final session closure', async () => {
    const run = await censusSequence(
      [
        censusSnapshot(censusRoot, censusChild),
        censusSnapshot(censusRoot),
        censusSnapshot(),
        censusSnapshot(),
      ],
      async (pid) => (pid === 88 ? censusRoot : undefined),
    );
    expect(run.error).toBeUndefined();
    expect(run.result?.exitCode).toBe(0);
    expect(run.snapshotReads).toBe(4);
    expect(run.enrolled).toEqual([88]);
    expect(run.signals).toEqual([]);
  });

  it('retains enrolled provenance when the known child exits between identity reads', async () => {
    let childReads = 0;
    const run = await censusSequence(
      [
        censusSnapshot(censusRoot, censusChild),
        censusSnapshot(censusRoot),
        censusSnapshot(),
        censusSnapshot(),
      ],
      async (pid) => (pid === 88 ? censusRoot : ++childReads === 1 ? censusChild : undefined),
    );
    expect(run.error).toBeUndefined();
    expect(run.enrolled).toEqual([88, 90]);
    expect(run.snapshotReads).toBe(4);
    expect(run.signals).toEqual([]);
  });

  it.each([
    ['same live row', censusChild, 'absence_not_confirmed'],
    ['reused PID', { ...censusChild, startTimeTicks: '99' }, 'generation_changed'],
    ['changed session', { ...censusChild, sid: 999 }, 'session_changed'],
  ] as const)(
    'holds rather than adopting %s after an absent identity',
    async (_name, present, reason) => {
      const run = await censusSequence(
        [censusSnapshot(censusRoot, censusChild), censusSnapshot(censusRoot, present)],
        async (pid) => (pid === 88 ? censusRoot : undefined),
      );
      expect(run.error).toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: { censusDiagnostic: { stage: 'absence_confirmation', reason } },
      });
      expect(run.snapshotReads).toBe(2);
      expect(run.enrolled).toEqual([88]);
      expect(run.signals).toEqual([]);
    },
  );

  it('does not retry a second disappearance during the one convergence pass', async () => {
    const second = { ...censusChild, pid: 91, startTimeTicks: '3' };
    const run = await censusSequence(
      [censusSnapshot(censusRoot, censusChild), censusSnapshot(censusRoot, second)],
      async (pid) => (pid === 88 ? censusRoot : undefined),
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'absence_confirmation', reason: 'convergence_exhausted' },
      },
    });
    expect(run.snapshotReads).toBe(2);
    expect(run.signals).toEqual([]);
  });

  it('does not adopt a descendant whose vanished parent was never verified', async () => {
    const orphan = { ...censusChild, pid: 91, ppid: 90, startTimeTicks: '3' };
    const run = await censusSequence(
      [censusSnapshot(censusRoot, censusChild), censusSnapshot(censusRoot, orphan)],
      async (pid) => (pid === 88 ? censusRoot : undefined),
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'enrollment', reason: 'ancestry_unproven' },
      },
    });
    expect(run.enrolled).toEqual([88]);
    expect(run.signals).toEqual([]);
  });

  it.each([
    ['missing executable', 'process_executable_unavailable'],
    ['permission', 'process_executable_permission_denied'],
    ['malformed stat', 'process_stat_malformed'],
  ])(
    'reports a fixed %s helper reason without absence retries or raw detail',
    async (_name, code) => {
      const run = await censusSequence([censusSnapshot(censusRoot, censusChild)], async (pid) => {
        if (pid === 88) return censusRoot;
        throw Object.assign(new Error('private process content'), { code });
      });
      expect(run.error).toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: { censusDiagnostic: { stage: 'new_identity_read', reason: code } },
      });
      expect(JSON.stringify(run.error)).not.toContain('private process content');
      expect(run.snapshotReads).toBe(1);
      expect(run.enrolled).toEqual([88]);
      expect(run.signals).toEqual([]);
    },
  );

  it('holds precisely on reparenting between snapshot and first identity', async () => {
    const run = await censusSequence([censusSnapshot(censusRoot, censusChild)], async (pid) =>
      pid === 88 ? censusRoot : { ...censusChild, ppid: 1 },
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'new_identity_compare', reason: 'parent_changed' },
      },
    });
    expect(run.signals).toEqual([]);
  });

  it('holds precisely on executable change between enrollment and known identity recheck', async () => {
    let childReads = 0;
    const run = await censusSequence([censusSnapshot(censusRoot, censusChild)], async (pid) =>
      pid === 88
        ? censusRoot
        : { ...censusChild, exe: ++childReads === 1 ? '/synthetic/node' : '/synthetic/other' },
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'known_identity_compare', reason: 'executable_changed' },
      },
    });
    expect(run.signals).toEqual([]);
  });

  it('rejects a reused known root before enrolling children', async () => {
    const run = await censusSequence(
      [censusSnapshot({ ...censusRoot, startTimeTicks: '99' }, censusChild)],
      async () => censusRoot,
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'known_identity_compare', reason: 'generation_changed' },
      },
    });
    expect(run.enrolled).toEqual([88]);
    expect(run.signals).toEqual([]);
  });

  it('still holds on an unknown final descendant after an absence reconciliation', async () => {
    const orphan = { ...censusChild, pid: 91, ppid: 90, startTimeTicks: '3' };
    const run = await censusSequence(
      [censusSnapshot(censusRoot, censusChild), censusSnapshot(censusRoot), censusSnapshot(orphan)],
      async (pid) => (pid === 88 ? censusRoot : undefined),
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        stage: 'final_session_census',
        censusDiagnostic: { stage: 'enrollment', reason: 'ancestry_unproven' },
      },
    });
    expect(run.signals).toEqual([]);
    expect(run.enrolled).toEqual([88]);
  });

  it('attributes the independent final snapshot failure without raw helper text', async () => {
    const run = await censusSequence(
      [
        censusSnapshot(censusRoot),
        censusSnapshot(),
        Object.assign(new Error('private process row'), { code: 'process_census_unavailable' }),
      ],
      async () => censusRoot,
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        stage: 'final_session_census',
        censusDiagnostic: { stage: 'final_snapshot', reason: 'process_census_unavailable' },
      },
    });
    expect(run.snapshotReads).toBe(3);
    expect(run.signals).toEqual([]);
    expect(JSON.stringify(run.error)).not.toContain('private process row');
  });

  it('reports snapshot helper failures as a fixed census reason', async () => {
    const run = await censusSequence(
      [Object.assign(new Error('private row'), { code: 'process_stat_permission_denied' })],
      async () => censusRoot,
    );
    expect(run.error).toMatchObject({
      operationSettled: false,
      utilityChildDiagnostic: {
        censusDiagnostic: { stage: 'snapshot', reason: 'process_stat_permission_denied' },
      },
    });
    expect(run.signals).toEqual([]);
  });

  it('carries only the fixed census fields into the content-free receipt', async () => {
    const run = await censusSequence([censusSnapshot(censusRoot, censusChild)], async (pid) => {
      if (pid === 88) return censusRoot;
      throw Object.assign(new Error('private row must never enter receipt'), {
        code: 'process_stat_permission_denied',
      });
    });
    const ops = new FakeOps();
    ops.preparationFailure = { stage: 'migration_child', error: run.error };
    const receipt = await runBasic5CiAcceptance(ops);
    expect(receipt.utilityChildDiagnostic).toMatchObject({
      censusDiagnostic: {
        stage: 'new_identity_read',
        reason: 'process_stat_permission_denied',
      },
    });
    expect(receipt.operationSettled).toBe(false);
    expect(receipt.cleanupComplete).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('private row');
  });

  it('runs real preflight metadata orchestration with the instance clock and no processes', async () => {
    const calls: string[] = [];
    const driver = {
      ...utilityChildDriver(new FakeDirectChild()),
      clock: 1_000,
      now() {
        return this.clock;
      },
      metadataExec(command, args, options, callback) {
        expect(this).toBe(driver);
        expect(options.timeout).toBe(5_000 - calls.length * 100);
        calls.push([command, ...args].join(' '));
        this.clock += 100;
        const stdout =
          args[0] === '--version'
            ? 'Google Chrome 156.0.8078.47\n'
            : args[0] === 'status'
              ? ''
              : args[1] === 'HEAD'
                ? preflight.sourceCommit
                : preflight.sourceWebTree;
        callback(null, Buffer.from(stdout), Buffer.alloc(0));
      },
      spawn() {
        throw new Error('Real preflight must not use the utility spawn path.');
      },
    } satisfies Basic5CiUtilityChildTestDriver & { clock: number };
    driver.proof.BASIC5_CI_CHROME_EXECUTABLE = '/opt/google/chrome/chrome';
    const ops = new RealBasic5CiOps(driver);
    const internal = ops as unknown as {
      privateRoot: string;
      importHelpers(): Promise<void>;
      readListeners(): Promise<Map<string, number>>;
      provenance: {
        observeBasic5CiBuildProvenance(): Promise<unknown>;
      };
    };
    const importHelpers = vi.spyOn(internal, 'importHelpers').mockResolvedValue(undefined);
    const readListeners = vi.spyOn(internal, 'readListeners').mockResolvedValue(new Map());
    internal.provenance = {
      observeBasic5CiBuildProvenance: async () => ({
        source: { commit: preflight.sourceCommit, webTree: preflight.sourceWebTree },
        requiredArtifactIdentity: preflight.requiredArtifactIdentity,
        runtime: {
          nodeVersion: 'v26.13.0',
          imageOS: preflight.imageOS,
          imageVersion: preflight.imageVersion,
        },
        diagnosticTraceCompleteness: preflight.diagnosticTraceCompleteness,
        buildExecutionAttribution: preflight.buildExecutionAttribution,
        limitations: preflight.provenanceLimitations,
      }),
    };
    const originalEnvironment = { ...process.env };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const version = Object.getOwnPropertyDescriptor(process, 'version');
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      Object.defineProperty(process, 'version', { configurable: true, value: 'v26.13.0' });
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: preflight.sourceCommit,
        GITHUB_WORKFLOW_SHA: preflight.sourceCommit,
        ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE: '1',
        ASSISTANT_BASIC5_CI_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/synthetic',
        GITHUB_WORKSPACE: fileURLToPath(new URL('..', import.meta.url)),
        RUNNER_OS: 'Linux',
        ImageOS: preflight.imageOS,
        ImageVersion: preflight.imageVersion,
      });
      const result = await ops.preflight(6_000, new AbortController().signal);
      expect(result.sourceCommit).toBe(preflight.sourceCommit);
      expect(result.chromeVersion).toBe('156.0.8078.47');
      expect(result.postgresServerVersionNum).toBeNull();
      expect(calls).toEqual([
        'git rev-parse HEAD',
        'git status --porcelain=v1 --untracked-files=all',
        'git rev-parse HEAD:apps/web',
        '/opt/google/chrome/chrome --version',
      ]);
      expect(driver.clock).toBe(1_400);
      expect(readListeners).toHaveBeenCalledOnce();
    } finally {
      ops.dispose();
      importHelpers.mockRestore();
      readListeners.mockRestore();
      if (platform) Object.defineProperty(process, 'platform', platform);
      if (version) Object.defineProperty(process, 'version', version);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
      if (internal.privateRoot) await rm(internal.privateRoot, { recursive: true });
    }
  });

  it.each([
    ['create-target', 'target_database_creation'],
    ['migrate', 'migration_child'],
    ['seed', 'seed_child'],
  ] as const)(
    'runs %s through the owned-child lifecycle and retains stderr counts',
    async (label, utility) => {
      const child = new FakeDirectChild();
      const stdout = child.stdout as EventEmitter;
      const stderr = child.stderr as EventEmitter;
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from('ok\n'));
        stderr.emit('data', Buffer.from('harmless diagnostic\n'));
        child.emit('close', 0, null);
      });
      const ops = new RealBasic5CiOps(utilityChildDriver(child));
      try {
        const result = await ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          10_000,
          label,
          new AbortController().signal,
        );
        expect(result.exitCode).toBe(0);
        expect(result.utilityDiagnostic).toMatchObject({
          utility,
          stage: 'completed',
          status: 'completed',
          closed: true,
          stdoutBytes: 3,
          stderrBytes: 20,
        });
        assertBasic5CiUtilityChildSucceeded(utility, result);
      } finally {
        ops.dispose();
      }
    },
  );

  it.each([
    ['ENOENT', 'not_found'],
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['EMFILE', 'resource_exhausted'],
    ['ENFILE', 'resource_exhausted'],
    ['ENOMEM', 'resource_exhausted'],
  ] as const)(
    'records asynchronous spawn error %s without closing unknown work',
    async (code, errnoCategory) => {
      const child = new FakeDirectChild();
      child.pid = undefined;
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('private path'), { code }));
        child.emit('close', null, null);
      });
      const ops = new RealBasic5CiOps(utilityChildDriver(child));
      try {
        await expect(
          ops.runUtilityChild(
            '/missing/synthetic-node',
            [],
            {},
            10_000,
            'create-target',
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          operationSettled: false,
          utilityChildDiagnostic: {
            stage: 'spawn',
            status: 'spawn_error',
            errnoCategory,
            closed: true,
          },
        });
      } finally {
        ops.dispose();
      }
    },
  );

  it('retains structural bootstrap identity errno without retaining the error text', async () => {
    const child = new FakeDirectChild();
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readIdentity: async () => {
          throw Object.assign(new Error('private process path'), { code: 'EACCES' });
        },
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          [],
          {},
          10_000,
          'migrate',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          stage: 'bootstrap',
          status: 'bootstrap_unverified',
          errnoCategory: 'permission_denied',
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it('does not enroll unrelated zero group/session rows from global census', async () => {
    const child = new FakeDirectChild();
    queueMicrotask(() => child.emit('close', 0, null));
    const identityReads: number[] = [];
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readIdentity: async (pid) => {
          identityReads.push(pid);
          return pid === 88
            ? {
                pid,
                ppid: process.pid,
                pgid: 88,
                sid: 88,
                startTimeTicks: '1',
                exe: '/synthetic/node',
              }
            : undefined;
        },
        readSnapshot: async () =>
          new Map([[77, { pid: 77, ppid: 1, pgid: 0, sid: 0, startTimeTicks: '9' }]]),
      }),
    );
    try {
      await ops.runUtilityChild(
        '/synthetic/node',
        [],
        {},
        10_000,
        'seed',
        new AbortController().signal,
      );
      expect(identityReads).toEqual([88]);
    } finally {
      ops.dispose();
    }
  });

  it('rejects a direct owned bootstrap identity with zero pgid or sid', async () => {
    for (const field of ['pgid', 'sid'] as const) {
      const child = new FakeDirectChild();
      const ops = new RealBasic5CiOps(
        utilityChildDriver(child, {
          readIdentity: async () => ({
            pid: 88,
            ppid: process.pid,
            pgid: field === 'pgid' ? 0 : 88,
            sid: field === 'sid' ? 0 : 88,
            startTimeTicks: '1',
            exe: '/synthetic/node',
          }),
        }),
      );
      try {
        await expect(
          ops.runUtilityChild(
            '/synthetic/node',
            [],
            {},
            10_000,
            'seed',
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ operationSettled: false });
      } finally {
        ops.dispose();
      }
    }
  });

  it.each([
    ['create-target', 'target_database_creation'],
    ['migrate', 'migration_child'],
    ['seed', 'seed_child'],
  ] as const)('%s short-exit bootstrap failure stays unsettled', async (label, utility) => {
    const child = new FakeDirectChild();
    child.pid = 88;
    queueMicrotask(() => child.emit('close', 0, null));
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readIdentity: async () => {
          await Promise.resolve();
          return undefined;
        },
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          10_000,
          label,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          utility,
          stage: 'bootstrap',
          status: 'bootstrap_unverified',
          exitCode: 0,
          closed: true,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it.each([
    ['create-target', 'target_database_creation'],
    ['migrate', 'migration_child'],
    ['seed', 'seed_child'],
  ] as const)('%s retains settled nonzero exit as a utility failure', async (label, utility) => {
    const child = new FakeDirectChild();
    queueMicrotask(() => child.emit('close', 7, null));
    const ops = new RealBasic5CiOps(utilityChildDriver(child));
    try {
      const result = await ops.runUtilityChild(
        '/synthetic/node',
        ['utility'],
        {},
        10_000,
        label,
        new AbortController().signal,
      );
      expect(result.exitCode).toBe(7);
      let caught: unknown;
      try {
        assertBasic5CiUtilityChildSucceeded(utility, result);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: `${utility}_nonzero_exit`,
        utilityChildDiagnostic: { utility, exitCode: 7, closed: true },
      });
    } finally {
      ops.dispose();
    }
  });

  it('holds when the owned session census fails during child execution', async () => {
    const child = new FakeDirectChild();
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readSnapshot: async () => {
          throw new Error('private process details');
        },
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          10_000,
          'migrate',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          stage: 'owned_session_census',
          status: 'session_census_unverified',
          closed: false,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it('holds when the final child-session census fails after child close', async () => {
    const child = new FakeDirectChild();
    queueMicrotask(() => child.emit('close', 0, null));
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readSnapshot: async () => {
          throw new Error('private process details');
        },
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          10_000,
          'seed',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          stage: 'final_session_census',
          status: 'session_census_unverified',
          closed: true,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it('keeps a final census that sees a child descendant unsettled', async () => {
    const child = new FakeDirectChild();
    queueMicrotask(() => child.emit('close', 0, null));
    const descendant = {
      pid: 90,
      ppid: 88,
      pgid: 88,
      sid: 88,
      startTimeTicks: '2',
    };
    let snapshotRead = 0;
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        readIdentity: async (pid) =>
          pid === 88
            ? {
                pid,
                ppid: process.pid,
                pgid: 88,
                sid: 88,
                startTimeTicks: '1',
                exe: '/synthetic/node',
              }
            : { ...descendant, exe: '/synthetic/descendant' },
        readSnapshot: async () => {
          snapshotRead += 1;
          return snapshotRead === 2 ? new Map([[90, descendant]]) : new Map();
        },
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          [],
          {},
          10_000,
          'seed',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          stage: 'final_session_census',
          status: 'session_census_unverified',
          closed: true,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it('holds on child output caps with bounded diagnostics', async () => {
    const child = new FakeDirectChild();
    queueMicrotask(() => (child.stdout as EventEmitter).emit('data', Buffer.alloc(64 * 1024 + 1)));
    const ops = new RealBasic5CiOps(utilityChildDriver(child));
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          10_000,
          'migrate',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          status: 'capture_limit',
          stdoutBytes: 64 * 1024,
          closed: false,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it('holds on the owned-child deadline with an unsettled diagnostic', async () => {
    const child = new FakeDirectChild();
    let clockReads = 0;
    const ops = new RealBasic5CiOps(
      utilityChildDriver(child, {
        now: () => [1, 1, 5_001, 5_001][clockReads++] ?? 5_001,
      }),
    );
    try {
      await expect(
        ops.runUtilityChild(
          '/synthetic/node',
          ['utility'],
          {},
          5_000,
          'seed',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          status: 'deadline',
          closed: false,
        },
      });
    } finally {
      ops.dispose();
    }
  });

  it.each(['target_database_creation', 'migration_child', 'seed_child'] as const)(
    '%s accepts settled exit zero with diagnostic stderr',
    (utility) => {
      expect(() =>
        assertBasic5CiUtilityChildSucceeded(utility, {
          exitCode: 0,
          stderr: Buffer.from('bounded diagnostic only'),
          utilityDiagnostic: {
            utility,
            stage: 'completed',
            status: 'completed',
            exitCode: 0,
            signal: null,
            closed: true,
            stdoutBytes: 0,
            stderrBytes: 24,
            errnoCategory: null,
            sqlStateClass: null,
          },
        }),
      ).not.toThrow();
    },
  );

  it.each(['target_database_creation', 'migration_child', 'seed_child'] as const)(
    '%s holds a settled nonzero exit with content-free child evidence',
    async (utility) => {
      const diagnostic = {
        utility,
        stage: 'completed' as const,
        status: 'completed' as const,
        exitCode: 1,
        signal: null,
        closed: true,
        stdoutBytes: 8,
        stderrBytes: 16,
        errnoCategory: null,
        sqlStateClass: null,
      };
      await expect(
        runBasic5CiPreparationStep(utility, `${utility}_failed`, () =>
          assertBasic5CiUtilityChildSucceeded(utility, {
            exitCode: 1,
            stderr: Buffer.from('private database url must not be retained'),
            utilityDiagnostic: diagnostic,
          }),
        ),
      ).rejects.toMatchObject({
        code: `${utility}_nonzero_exit`,
        preparationDiagnostic: { category: 'controller_hold' },
        utilityChildDiagnostic: diagnostic,
      });
    },
  );

  it('keeps short-exit bootstrap failure unsettled and does not infer descendant closure', async () => {
    for (const utility of ['target_database_creation', 'migration_child', 'seed_child'] as const) {
      const hold = holdForBasic5CiUtilityBootstrapFailure(
        utility,
        new Basic5CiHold('child_bootstrap_identity_unavailable', false),
        { exitCode: 0, closed: true, stdoutBytes: 4, stderrBytes: 7 },
      );
      expect(hold).toMatchObject({
        operationSettled: false,
        utilityChildDiagnostic: {
          utility,
          stage: 'bootstrap',
          status: 'bootstrap_unverified',
          exitCode: 0,
          closed: true,
          stdoutBytes: 4,
          stderrBytes: 7,
        },
      });
    }
  });

  it('preserves both the primary database failure and pool-close failure stages', () => {
    const primary = new Basic5CiHold(
      'database_ownership_check_failed',
      true,
      undefined,
      undefined,
      {
        stage: 'database_ownership_check',
        category: 'operation_error',
      },
    );
    const close = new Basic5CiHold('database_pool_close_failed', true, undefined, undefined, {
      stage: 'database_pool_close',
      category: 'operation_error',
    });
    expect(combineBasic5CiPreparationFailures(primary, close)).toMatchObject({
      code: 'database_ownership_check_failed',
      preparationDiagnostic: {
        stage: 'database_ownership_check',
        category: 'operation_error',
        secondaryStage: 'database_pool_close',
        secondaryCategory: 'operation_error',
      },
    });
  });

  it('resolves the actual TSX preparation module imports without opening a database', () => {
    const script = [
      "const { pathToFileURL } = await import('node:url');",
      "const { createRequire } = await import('node:module');",
      "const { dirname, resolve } = await import('node:path');",
      "const { readFileSync, lstatSync } = await import('node:fs');",
      "const root = pathToFileURL(process.cwd() + '/');",
      "const targetSupport = await import(new URL('./scripts/test-target.js', root).href);",
      "const databasePackage = await import('@assistant/db');",
      "const require = createRequire(pathToFileURL(process.cwd() + '/package.json'));",
      "const vitestManifestPath = require.resolve('vitest/package.json');",
      "const vitestConfigEntry = require.resolve('vitest/config');",
      "const vitestManifest = JSON.parse(readFileSync(vitestManifestPath, 'utf8'));",
      "const vitestCli = resolve(dirname(vitestManifestPath), 'vitest.mjs');",
      "if (typeof targetSupport.allocateTestTarget !== 'function') process.exitCode = 1;",
      "if (typeof databasePackage.createDb !== 'function') process.exitCode = 1;",
      "if (typeof vitestConfigEntry !== 'string' || vitestConfigEntry.length === 0) process.exitCode = 1;",
      "if (vitestManifest.name !== 'vitest' || vitestManifest.bin?.vitest !== './vitest.mjs') process.exitCode = 1;",
      'const vitestCliStat = lstatSync(vitestCli);',
      'if (!vitestCliStat.isFile() || vitestCliStat.isSymbolicLink()) process.exitCode = 1;',
    ].join('\n');
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
        ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
      },
      timeout: 10_000,
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it.each([
    'test_target_module_import',
    'target_allocation',
    'target_environment',
    'target_database_creation',
    'target_marker_verification',
    'database_module_import',
    'database_connection_open',
    'database_ownership_check',
    'server_version_query',
    'database_pool_close',
    'migration_child',
    'seed_child',
  ] as const)('bounds the diagnostic for preparation stage %s', async (stage) => {
    let caught: unknown;
    try {
      await runBasic5CiPreparationStep(stage, 'fixed_prepare_failure', () => {
        throw new Error('postgres://private-user:private-password@host/private-database');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'fixed_prepare_failure',
      preparationDiagnostic: { stage, category: 'operation_error' },
    });
    expect((caught as Error).message).not.toContain('private-password');
  });

  it.each([
    ['ERR_MODULE_NOT_FOUND', 'Error', 'module_resolution'],
    ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'Error', 'module_resolution'],
    ['ERR_UNKNOWN_FILE_EXTENSION', 'TypeError', 'module_resolution'],
    ['ENOENT', 'Error', 'filesystem_missing'],
    ['EACCES', 'Error', 'permission_denied'],
    ['EPERM', 'Error', 'permission_denied'],
    [undefined, 'TypeError', 'type_error'],
    [undefined, 'SyntaxError', 'syntax_error'],
    ['EIO', 'Error', 'operation_error'],
  ] as const)('classifies preparation error code %s and name %s', async (code, name, category) => {
    const failure = Object.assign(new Error('postgres://private-user:private-password@host/db'), {
      ...(code ? { code } : {}),
      name,
    });
    let caught: unknown;
    try {
      await runBasic5CiPreparationStep('database_module_import', 'fixed_import_failure', () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'fixed_import_failure',
      preparationDiagnostic: { stage: 'database_module_import', category },
    });
    expect((caught as Error).message).not.toContain('private-password');
  });

  it('accepts a valid Chrome version banner when stderr has harmless diagnostics', () => {
    const observed = observeBasic5CiChromeVersion({
      exitCode: 0,
      stdout: Buffer.from('Google Chrome 144.0.0.0\n'),
      stderr: Buffer.from('harmless diagnostic\n'),
    });
    expect(observed.version).toBe('144.0.0.0');
    expect(observed.diagnostic).toEqual({
      status: 'accepted',
      exitCode: 0,
      stdoutBytes: 24,
      stderrBytes: 20,
    });
    expect(JSON.stringify(observed)).not.toContain('harmless diagnostic');
  });

  it.each([
    ['no terminator', 'Google Chrome 144.0.0.0'],
    ['one LF', 'Google Chrome 144.0.0.0\n'],
    ['one CRLF', 'Google Chrome 144.0.0.0\r\n'],
    ['ASCII space and tab at line edges', '\t Google Chrome 144.0.0.0 \t'],
    [
      'testing build with line-edge whitespace and CRLF',
      '\tGoogle Chrome for Testing 144.0.0.0 \r\n',
    ],
  ])('accepts the bounded Chrome version banner format: %s', (_label, stdout) => {
    expect(
      observeBasic5CiChromeVersion({
        exitCode: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      }),
    ).toMatchObject({
      version: '144.0.0.0',
      diagnostic: { status: 'accepted', exitCode: 0 },
    });
  });

  it.each([
    ['embedded LF', 'Google Chrome 144.0.0.0\nextra'],
    ['embedded CRLF', 'Google Chrome 144.0.0.0\r\nextra'],
    ['two final LFs', 'Google Chrome 144.0.0.0\n\n'],
    ['LF followed by CRLF', 'Google Chrome 144.0.0.0\n\r\n'],
    ['bare CR', 'Google Chrome 144.0.0.0\r'],
    ['NUL', 'Google Chrome 144.0.0.0\0'],
    ['vertical tab', 'Google Chrome 144.0.0.0\v'],
    ['form feed', 'Google Chrome 144.0.0.0\f'],
    ['escape', 'Google Chrome 144.0.0.0\u001b'],
    ['Unicode space', '\u00a0Google Chrome 144.0.0.0'],
    ['non-Google banner', 'Chromium 144.0.0.0'],
    ['digits only', '144.0.0.0'],
    ['three-part version', 'Google Chrome 144.0.0'],
    ['five-part version', 'Google Chrome 144.0.0.0.1'],
    ['non-numeric version part', 'Google Chrome 144.0.x.0'],
  ])('holds on invalid Chrome banner (%s)', (_label, stdout) => {
    const observed = observeBasic5CiChromeVersion({
      exitCode: 0,
      stdout: Buffer.from(stdout),
      stderr: Buffer.alloc(0),
    });
    expect(observed.version).toBeNull();
    expect(observed.diagnostic.status).toBe('version_unparseable');
    expect(JSON.stringify(observed)).not.toContain(stdout);
  });

  it('holds on a nonzero Chrome exit even when stdout contains a valid version', () => {
    const observed = observeBasic5CiChromeVersion({
      exitCode: 7,
      stdout: Buffer.from('Google Chrome 144.0.0.0\n'),
      stderr: Buffer.alloc(0),
    });
    expect(observed.version).toBeNull();
    expect(observed.diagnostic).toMatchObject({ status: 'nonzero_exit', exitCode: 7 });
  });

  it('holds on malformed Chrome version output without retaining the output', () => {
    const observed = observeBasic5CiChromeVersion({
      exitCode: 0,
      stdout: Buffer.from('untrusted version text\n'),
      stderr: Buffer.alloc(0),
    });
    expect(observed.version).toBeNull();
    expect(observed.diagnostic.status).toBe('version_unparseable');
    expect(JSON.stringify(observed)).not.toContain('untrusted version text');
  });

  it('rejects output above the bounded capture limit', () => {
    const observed = observeBasic5CiChromeVersion({
      exitCode: 0,
      stdout: Buffer.alloc(64 * 1024 + 1, 65),
      stderr: Buffer.alloc(0),
    });
    expect(observed.version).toBeNull();
    expect(observed.diagnostic.status).toBe('capture_limit');
    expect(observed.diagnostic.stdoutBytes).toBe(64 * 1024);
  });

  it('classifies a bounded Chrome command exit without preserving stderr text', async () => {
    const result = await runBasic5CiReadOnlyMetadata(
      '/opt/google/chrome/chrome',
      ['--version'],
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
        callback(null, Buffer.from('Google Chrome 144.0.0.0\n'), Buffer.from('notice\n'));
        return {};
      },
    );
    expect(observeBasic5CiChromeVersion(result).diagnostic).toEqual({
      status: 'accepted',
      exitCode: 0,
      stdoutBytes: 24,
      stderrBytes: 7,
    });
  });

  it('reports the execFile max-buffer code as a bounded capture limit', async () => {
    await expect(
      runBasic5CiReadOnlyMetadata(
        '/opt/google/chrome/chrome',
        ['--version'],
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
          callback(
            Object.assign(new Error('do not retain this'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }),
            Buffer.alloc(64 * 1024),
            Buffer.alloc(0),
          );
          return {};
        },
      ),
    ).rejects.toMatchObject({ code: 'metadata_command_capture_limit' });
  });

  it('admits only the authorized first main push workflow invocation', () => {
    const accepted = {
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
      ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE: '1',
    };
    expect(() => assertBasic5CiWorkflowAdmission(accepted)).not.toThrow();
    expect(() =>
      assertBasic5CiWorkflowAdmission({ ...accepted, GITHUB_EVENT_NAME: 'pull_request' }),
    ).toThrow('workflow_admission_context_not_authorized');
    expect(() => assertBasic5CiWorkflowAdmission({ ...accepted, GITHUB_RUN_ATTEMPT: '2' })).toThrow(
      'workflow_admission_context_not_authorized',
    );
  });

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
        buildIdSha256Valid: true,
        serverSha256Valid: true,
        runtimeInventorySha256Valid: true,
        limitationsArray: true,
        limitationsCountBounded: true,
        limitationsItemsBounded: true,
        runtimeInventoryEntryCountPositive: true,
        runtimeInventoryFileCountPositive: true,
        runtimeInventorySymlinkCountValid: true,
        runtimeInventoryBytesPositive: true,
        staticAssetsPresent: true,
        staticAssetsNonempty: true,
        staticAssetsSha256Valid: true,
        publicAssetsPresent: true,
        publicAssetsNonempty: false,
        publicAssetsSha256Valid: true,
      },
      observed: {
        runtimeInventoryEntryCount: 100,
        runtimeInventoryFileCount: 80,
        runtimeInventorySymlinkCount: 20,
        runtimeInventoryBytes: 2 * 1024 * 1024 * 1024,
        staticAssetsFileCount: 8,
        publicAssetsFileCount: 0,
      },
    };
    ops.preflightError = new Basic5CiHold(
      'required_runtime_artifact_identity_incomplete',
      true,
      diagnostic,
    );

    const result = await runBasic5CiAcceptance(ops);

    expect(result.errorCode).toBe('required_runtime_artifact_identity_incomplete');
    expect(result.targetStatus).toBe('not_allocated');
    expect(result.acceptanceContract).toBe('basic5-ci-standalone-in-checkout-v2');
    expect(result.claimScope).toMatchObject({
      ancestorWorkspaceDependencies: 'unqualified',
      unexercisedRoutes: 'unqualified',
      containerIndependence: 'unqualified',
    });
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
    expect(result.schemaVersion).toBe(2);
    expect(result.acceptanceContract).toBe('basic5-ci-standalone-in-checkout-v2');
    expect(result.workflowContext).toMatchObject({
      event: 'push',
      ref: 'refs/heads/main',
      runAttempt: 1,
      frozenLockfileInstallAndBuildSucceeded: true,
      frozenLockfileBuildBasis: 'ordered_ci_steps_completed_before_acceptance',
    });
    expect(result.requiredArtifactIdentity).toMatchObject({
      buildId: 'build-1',
      runtimeInventorySha256: 'd'.repeat(64),
      staticAssets: { present: true, fileCount: 8, sha256: 'b'.repeat(64) },
      publicAssets: { present: true, fileCount: 4, sha256: 'e'.repeat(64) },
    });
    expect(result.diagnosticTraceCompleteness).toMatchObject({
      collection: 'not_requested',
      status: 'not_collected',
      manifestCount: null,
      referenceCount: null,
      unmatchedReferenceCount: null,
    });
    expect(result.chromeVersionDiagnostic).toEqual(preflight.chromeVersionDiagnostic);
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

  it('records only the fixed Chrome diagnostic when preflight holds', async () => {
    const ops = new FakeOps();
    ops.preflightError = new Basic5CiHold(
      'allowlisted_chrome_version_nonzero_exit',
      true,
      undefined,
      {
        status: 'nonzero_exit',
        exitCode: 1,
        stdoutBytes: 24,
        stderrBytes: 13,
      },
    );
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(result.chromeVersionDiagnostic).toEqual({
      status: 'nonzero_exit',
      exitCode: 1,
      stdoutBytes: 24,
      stderrBytes: 13,
    });
    expect(JSON.stringify(result)).not.toContain('raw Chrome output');
    expect(ops.events).toEqual(['preflight', 'receipt']);
  });

  it('reports the preparation stage and retains unknown target state on an injected failure', async () => {
    const ops = new FakeOps();
    ops.preflightValue = { ...preflight, postgresServerVersionNum: null };
    ops.preparationFailure = {
      stage: 'database_ownership_check',
      error: new Error('postgres://private-user:private-password@host/private-database'),
    };
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(result.errorCode).toBe('fake_preparation_failed');
    expect(result.preparationDiagnostic).toEqual({
      stage: 'database_ownership_check',
      category: 'operation_error',
    });
    expect(result.targetStatus).toBe('unknown');
    expect(result.targetRetained).toBeNull();
    expect(result.postgresServerVersionNum).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-password');
    expect(ops.events).toEqual(['preflight', 'prepare', 'quiesce', 'receipt']);
  });

  it('records fixed case-entry failures and retains the prepared target', async () => {
    const ops = new FakeOps();
    ops.caseEntryFailure = {
      stage: 'vitest_entry_resolution',
      error: Object.assign(
        new Error('postgres://private-user:private-password@host/private-database'),
        { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      ),
    };
    const result = await runBasic5CiAcceptance(ops);
    expect(result.result).toBe('hold');
    expect(result.errorCode).toBe('fake_case_entry_failed');
    expect(result.caseEntryDiagnostic).toEqual({
      stage: 'vitest_entry_resolution',
      category: 'module_resolution',
    });
    expect(result.targetStatus).toBe('retained');
    expect(JSON.stringify(result)).not.toContain('private-password');
    expect(ops.events).toEqual(['preflight', 'prepare', 'case', 'quiesce', 'receipt']);
  });

  it('sanitizes a captured-output limit diagnostic in the final receipt', async () => {
    const observation = observeBasic5CiChromeVersion({
      exitCode: 0,
      stdout: Buffer.alloc(40 * 1024),
      stderr: Buffer.alloc(30 * 1024),
    });
    const ops = new FakeOps();
    ops.preflightError = new Basic5CiHold(
      'allowlisted_chrome_version_capture_limit',
      true,
      undefined,
      observation.diagnostic,
    );
    const result = await runBasic5CiAcceptance(ops);
    expect(result.errorCode).toBe('allowlisted_chrome_version_capture_limit');
    expect(result.chromeVersionDiagnostic).toMatchObject({
      status: 'capture_limit',
      exitCode: 0,
      stdoutBytes: 40 * 1024,
      stderrBytes: 30 * 1024,
    });
    expect(JSON.stringify(result)).not.toContain('A'.repeat(20));
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

  it('records last-entered preparation stage on an unsettled prepare deadline without cleaning up', async () => {
    const ops = new FakeOps();
    ops.neverResolvePreparation = true;
    ops.preparationStage = 'database_ownership_check';
    const timers = {
      schedule(callback: () => void) {
        return setTimeout(callback, 0);
      },
      cancel(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer);
      },
    };
    const result = await runBasic5CiAcceptance(ops, timers);
    expect(result.errorCode).toBe('prepare_operation_unsettled');
    expect(result.operationSettled).toBe(false);
    expect(result.preparationDiagnostic).toEqual({
      stage: 'database_ownership_check',
      category: 'phase_deadline_or_unsettled',
    });
    expect(result.targetStatus).toBe('unknown');
    expect(result.targetRetained).toBeNull();
    expect(ops.events).toEqual(['preflight', 'prepare', 'receipt']);
  });

  it('leaves preparation stage unknown when an injected driver cannot report it', async () => {
    const ops = new FakeOps();
    ops.neverResolvePreparation = true;
    ops.reportPreparationStage = false;
    const timers = {
      schedule(callback: () => void) {
        return setTimeout(callback, 0);
      },
      cancel(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer);
      },
    };
    const result = await runBasic5CiAcceptance(ops, timers);
    expect(result.errorCode).toBe('prepare_operation_unsettled');
    expect(result.operationSettled).toBe(false);
    expect(result.preparationDiagnostic).toBeUndefined();
    expect(result.targetStatus).toBe('unknown');
    expect(result.targetRetained).toBeNull();
    expect(ops.events).toEqual(['preflight', 'prepare', 'receipt']);
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
    ops.preparationStage = 'seed_child';
    ops.caseEntryStage = 'vitest_child_execution';
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
    expect(result.caseEntryDiagnostic).toEqual({
      stage: 'vitest_child_execution',
      category: 'phase_deadline_or_unsettled',
    });
    expect(result.preparationDiagnostic).toBeUndefined();
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
