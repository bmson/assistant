import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  assertBasic5CiWorkflowAdmission,
  type Basic5CiCaseResult,
  type Basic5CiDirectChildHandle,
  type Basic5CiEvidence,
  Basic5CiHold,
  type Basic5CiOps,
  type Basic5CiPreflight,
  type Basic5CiQuiescence,
  type Basic5CiTarget,
  observeBasic5CiChromeVersion,
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
  chromeVersionDiagnostic: {
    status: 'accepted',
    exitCode: 0,
    stdoutBytes: 24,
    stderrBytes: 0,
  },
  postgresServerVersionNum: 170000,
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
