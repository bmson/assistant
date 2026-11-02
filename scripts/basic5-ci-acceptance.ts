/** One-shot CI controller for the existing four-save BASIC5 browser case. */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  type Basic5CiVitestDiagnostic,
  basic5CiVitestCaptureLimit,
  contentFreeBasic5CiVitestDiagnostic,
  observeBasic5CiVitestOutput,
} from './basic5-ci-vitest-diagnostics.js';

const OUTER_SECONDS = 420;
const TEST_START_SECONDS = 130;
const TEST_END_SECONDS = 310;
const CLEANUP_END_SECONDS = 400;
const PREPARE_END_SECONDS = 130;
const CAPTURE_BYTES = 64 * 1024;
const PHASE_SETTLEMENT_GRACE_MS = 5_000;
const ACCEPTANCE_CONTRACT = 'basic5-ci-user-flow-control-presentation-v5';
const CLAIM_SCOPE = {
  runtimeIdentity: 'bounded standalone artifact observed in CI checkout',
  behavior: 'four BASIC5 saves: scoped UI success and same-operation durable receipts',
  ancestorWorkspaceDependencies: 'unqualified',
  unexercisedRoutes: 'unqualified',
  containerIndependence: 'unqualified',
} as const;
const RECEIPT_PROVENANCE_LIMITATION =
  'The browser acceptance does not independently verify a second wire-body copy.';
const ACTIONS = [
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const;
const RECEIPT_ID_FIELDS = new Set([
  'contactId',
  'entityId',
  'relationId',
  'previousRelationId',
  'memoryId',
  'assertionId',
]);

export type Basic5CiTarget = {
  databaseUrl: string;
  databaseName: string;
  token: string;
};

export type Basic5CiEvidence = {
  result: 'passed' | 'failed';
  standalone: { sourceCommit: string; buildId: string; serverSha256: string };
  executionEnvironment: {
    platform: string;
    nodeVersion: string;
    browserChannel: string;
    browserVersion: string | null;
    postgresServerVersionNum: number | null;
  };
  fixture: {
    databaseTargetDigest: string;
    ownerId: string;
    epochPrivacyMatchedReady: boolean;
    baseline: { contactIds: string[]; entityIds: string[]; noteId: string; noteHash: string };
    generatedOperationIds: string[];
  };
  receipts: Array<{
    authority: string;
    command: string;
    operationId: string;
    requestHash: string;
    statusVersion: number;
    outcome: string;
    uiSavedAfterCleanBaseline: true;
    ids?: Record<string, string> | null;
  }>;
  durableReadbacks: Record<string, boolean>;
  counts: Record<string, unknown>;
  cleanup: Record<string, boolean>;
  externalCleanupSupervisorRequired: boolean;
  standardTestWrapperCleanupIsUnconditional: boolean;
  testFailure: string | null;
  cleanupFailure: string | null;
};

export type Basic5CiQuiescence = {
  known: boolean;
  registeredRoles: string[];
  liveOwnedProcesses: number;
  liveOwnedListeners: number;
  unknownProcesses: number;
  fixtureRegistryValid: boolean;
};

export type Basic5CiCaseResult = {
  exitCode: number;
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  evidence: Basic5CiEvidence;
};

export type Basic5CiPreflight = {
  sourceCommit: string;
  sourceWebTree: string;
  nodeVersion: string;
  imageOS: string;
  imageVersion: string;
  chromeVersion: string;
  chromeVersionDiagnostic: Basic5CiChromeVersionDiagnostic;
  postgresServerVersionNum: number | null;
  utilityChildDiagnostics: Basic5CiUtilityChildDiagnostic[];
  workflowContext: {
    event: 'push';
    ref: 'refs/heads/main';
    runAttempt: 1;
    frozenLockfileInstallAndBuildSucceeded: true;
    frozenLockfileBuildBasis: 'ordered_ci_steps_completed_before_acceptance';
    workflowSha: string;
    lockfileSha256: string;
  };
  requiredArtifactIdentity: {
    buildId: string;
    buildIdSha256: string;
    serverSha256: string;
    runtimeInventorySha256: string;
    runtimeInventoryEntryCount: number;
    runtimeInventoryFileCount: number;
    runtimeInventorySymlinkCount: number;
    runtimeInventoryBytes: number;
    staticAssets: { present: true; fileCount: number; sha256: string };
    publicAssets: { present: true; fileCount: number; sha256: string };
  };
  diagnosticTraceCompleteness: {
    scope: 'apps/web/.next/server';
    collection: 'not_requested' | 'collected';
    status: 'not_collected' | 'complete' | 'incomplete' | 'unavailable';
    manifestCount: number | null;
    manifestBytes: number | null;
    manifestSha256: string | null;
    referenceCount: number | null;
    resolvedCheckoutReferenceCount: number | null;
    matchedClosureContentCount: number | null;
    unmatchedReferenceCount: number | null;
  };
  buildExecutionAttribution: string;
  provenanceLimitations: string[];
};

const CENSUS_STAGES = [
  'snapshot',
  'enrollment',
  'new_identity_read',
  'new_identity_compare',
  'known_identity_read',
  'known_identity_compare',
  'absence_confirmation',
  'final_snapshot',
] as const;
const CENSUS_REASONS = [
  'process_census_unavailable',
  'process_stat_unavailable',
  'process_stat_permission_denied',
  'process_stat_malformed',
  'owned_process_identity_ineligible',
  'process_executable_unavailable',
  'process_executable_permission_denied',
  'process_identity_changed',
  'known_process_terminal',
  'helper_unclassified',
  'ancestry_unproven',
  'snapshot_row_missing',
  'generation_changed',
  'parent_changed',
  'group_changed',
  'session_changed',
  'executable_changed',
  'absence_not_confirmed',
  'convergence_exhausted',
  'descendants_still_present',
  'deadline',
] as const;
type Basic5CiCensusDiagnostic = {
  stage: (typeof CENSUS_STAGES)[number];
  reason: (typeof CENSUS_REASONS)[number];
};

export type Basic5CiUtilityChildDiagnostic = {
  censusDiagnostic?: Basic5CiCensusDiagnostic;
  utility: 'target_database_creation' | 'migration_child' | 'seed_child';
  stage: 'spawn' | 'bootstrap' | 'owned_session_census' | 'final_session_census' | 'completed';
  status:
    | 'spawn_error'
    | 'bootstrap_unverified'
    | 'session_census_unverified'
    | 'capture_limit'
    | 'deadline'
    | 'completed';
  exitCode: number | null;
  signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGABRT' | 'SIGPIPE' | 'SIGQUIT' | null;
  closed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  errnoCategory: 'not_found' | 'permission_denied' | 'resource_exhausted' | 'other' | null;
  sqlStateClass:
    | 'connection'
    | 'data'
    | 'integrity'
    | 'authorization'
    | 'transaction'
    | 'resource'
    | 'operator'
    | 'system'
    | 'internal'
    | 'other'
    | null;
  closureProof?: 'direct_child_closed_and_original_session_empty';
};

export type Basic5CiChromeVersionDiagnostic = {
  status:
    | 'accepted'
    | 'nonzero_exit'
    | 'version_unparseable'
    | 'spawn_or_timeout'
    | 'capture_limit';
  exitCode: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
};

export type Basic5CiPreparationDiagnostic = {
  stage:
    | 'test_target_module_import'
    | 'target_allocation'
    | 'target_environment'
    | 'target_database_creation'
    | 'target_marker_verification'
    | 'database_module_import'
    | 'database_connection_open'
    | 'database_ownership_check'
    | 'server_version_query'
    | 'database_pool_close'
    | 'migration_child'
    | 'seed_child';
  category:
    | 'controller_hold'
    | 'module_resolution'
    | 'type_error'
    | 'syntax_error'
    | 'filesystem_missing'
    | 'permission_denied'
    | 'phase_deadline_or_unsettled'
    | 'operation_error';
  secondaryStage?: Basic5CiPreparationDiagnostic['stage'];
  secondaryCategory?: Basic5CiPreparationDiagnostic['category'];
};

export function assertBasic5CiUtilityChildSucceeded(
  utility: Basic5CiUtilityChildDiagnostic['utility'],
  result: {
    exitCode: number;
    stderr: Buffer;
    utilityDiagnostic?: Basic5CiUtilityChildDiagnostic;
  },
): void {
  void result.stderr;
  if (result.exitCode !== 0)
    throw new Basic5CiHold(
      `${utility}_nonzero_exit`,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      result.utilityDiagnostic,
    );
}

function utilityForChildLabel(
  label: string,
): Basic5CiUtilityChildDiagnostic['utility'] | undefined {
  if (label === 'create-target') return 'target_database_creation';
  if (label === 'migrate') return 'migration_child';
  if (label === 'seed') return 'seed_child';
  return undefined;
}

function makeUtilityChildDiagnostic(
  utility: Basic5CiUtilityChildDiagnostic['utility'],
  stage: Basic5CiUtilityChildDiagnostic['stage'],
  status: Basic5CiUtilityChildDiagnostic['status'],
  exitCode: number | null,
  closed: boolean,
  stdoutBytes: number,
  stderrBytes: number,
  error?: unknown,
  signal?: NodeJS.Signals | null,
  closureProof?: Basic5CiUtilityChildDiagnostic['closureProof'],
): Basic5CiUtilityChildDiagnostic {
  const errorCode =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? (error as NodeJS.ErrnoException).code
        : undefined;
  const errnoCategory =
    errorCode === 'ENOENT'
      ? 'not_found'
      : errorCode === 'EACCES' || errorCode === 'EPERM'
        ? 'permission_denied'
        : errorCode === 'EMFILE' || errorCode === 'ENFILE' || errorCode === 'ENOMEM'
          ? 'resource_exhausted'
          : typeof errorCode === 'string'
            ? 'other'
            : null;
  const safeSignals: NodeJS.Signals[] = [
    'SIGTERM',
    'SIGKILL',
    'SIGINT',
    'SIGABRT',
    'SIGPIPE',
    'SIGQUIT',
  ];
  const sqlStatePrefix =
    typeof errorCode === 'string' && /^[0-9A-Z]{5}$/.test(errorCode) ? errorCode.slice(0, 2) : null;
  const sqlStateClass =
    sqlStatePrefix === '08'
      ? 'connection'
      : ['21', '22'].includes(sqlStatePrefix ?? '')
        ? 'data'
        : sqlStatePrefix === '23'
          ? 'integrity'
          : sqlStatePrefix === '28'
            ? 'authorization'
            : ['25', '40'].includes(sqlStatePrefix ?? '')
              ? 'transaction'
              : ['53', '54', '55'].includes(sqlStatePrefix ?? '')
                ? 'resource'
                : sqlStatePrefix === '57'
                  ? 'operator'
                  : sqlStatePrefix === '58'
                    ? 'system'
                    : sqlStatePrefix === 'XX'
                      ? 'internal'
                      : sqlStatePrefix
                        ? 'other'
                        : null;
  return {
    utility,
    ...(error instanceof Basic5CiCensusHold ? { censusDiagnostic: error.censusDiagnostic } : {}),
    stage,
    status,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    signal:
      signal && safeSignals.includes(signal)
        ? (signal as 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGABRT' | 'SIGPIPE' | 'SIGQUIT')
        : null,
    closed,
    stdoutBytes: Math.min(CAPTURE_BYTES, Math.max(0, stdoutBytes)),
    stderrBytes: Math.min(CAPTURE_BYTES, Math.max(0, stderrBytes)),
    errnoCategory,
    sqlStateClass,
    ...(closureProof ? { closureProof } : {}),
  };
}

export function holdForBasic5CiUtilityBootstrapFailure(
  utility: Basic5CiUtilityChildDiagnostic['utility'],
  error: unknown,
  state: {
    exitCode: number | null;
    closed: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    signal?: NodeJS.Signals | null;
    errnoCode?: string;
    launchAbsent?: boolean;
  },
): Basic5CiHold {
  const hold = error instanceof Basic5CiHold ? error : undefined;
  const launchAbsent =
    state.launchAbsent === true &&
    ['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOMEM'].includes(state.errnoCode ?? '');
  return new Basic5CiHold(
    hold?.code ?? `${utility}_bootstrap_unverified`,
    hold?.operationSettled ?? false,
    undefined,
    undefined,
    undefined,
    undefined,
    makeUtilityChildDiagnostic(
      utility,
      launchAbsent ? 'spawn' : 'bootstrap',
      launchAbsent ? 'spawn_error' : 'bootstrap_unverified',
      state.exitCode,
      state.closed,
      state.stdoutBytes,
      state.stderrBytes,
      state.errnoCode ?? error,
      state.signal,
    ),
  );
}

function contentFreeUtilityChildDiagnostics(value: unknown): Basic5CiUtilityChildDiagnostic[] {
  if (!Array.isArray(value) || value.length > 3)
    throw new Basic5CiHold('utility_child_diagnostics_malformed');
  const utilities = ['target_database_creation', 'migration_child', 'seed_child'];
  const stages = [
    'spawn',
    'bootstrap',
    'owned_session_census',
    'final_session_census',
    'completed',
  ];
  const statuses = [
    'spawn_error',
    'bootstrap_unverified',
    'session_census_unverified',
    'capture_limit',
    'deadline',
    'completed',
  ];
  const signals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGPIPE', 'SIGQUIT'];
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Basic5CiHold('utility_child_diagnostic_malformed');
    const row = entry as Record<string, unknown>;
    const keys = [
      'utility',
      'stage',
      'status',
      'exitCode',
      'signal',
      'closed',
      'stdoutBytes',
      'stderrBytes',
      'errnoCategory',
      'sqlStateClass',
    ];
    if ('censusDiagnostic' in row) {
      const diagnostic = row.censusDiagnostic as Basic5CiCensusDiagnostic | null;
      if (
        !diagnostic ||
        typeof diagnostic !== 'object' ||
        Object.keys(diagnostic).length !== 2 ||
        !Object.hasOwn(diagnostic, 'stage') ||
        !Object.hasOwn(diagnostic, 'reason') ||
        !CENSUS_STAGES.includes(diagnostic.stage) ||
        !CENSUS_REASONS.includes(diagnostic.reason)
      )
        throw new Basic5CiHold('utility_child_diagnostic_malformed');
    }
    if (
      Object.keys(row).length !==
        keys.length + ('censusDiagnostic' in row ? 1 : 0) + ('closureProof' in row ? 1 : 0) ||
      keys.some((key) => !Object.hasOwn(row, key)) ||
      (Object.hasOwn(row, 'closureProof') &&
        (row.closureProof !== 'direct_child_closed_and_original_session_empty' ||
          row.stage !== 'completed' ||
          row.status !== 'completed' ||
          row.closed !== true ||
          row.exitCode !== 0)) ||
      !utilities.includes(String(row.utility)) ||
      !stages.includes(String(row.stage)) ||
      !statuses.includes(String(row.status)) ||
      !(row.exitCode === null || Number.isSafeInteger(row.exitCode)) ||
      !(row.signal === null || signals.includes(String(row.signal))) ||
      typeof row.closed !== 'boolean' ||
      !Number.isSafeInteger(row.stdoutBytes) ||
      Number(row.stdoutBytes) < 0 ||
      Number(row.stdoutBytes) > CAPTURE_BYTES ||
      !Number.isSafeInteger(row.stderrBytes) ||
      Number(row.stderrBytes) < 0 ||
      Number(row.stderrBytes) > CAPTURE_BYTES ||
      ![null, 'not_found', 'permission_denied', 'resource_exhausted', 'other'].includes(
        row.errnoCategory as string | null,
      ) ||
      ![
        null,
        'connection',
        'data',
        'integrity',
        'authorization',
        'transaction',
        'resource',
        'operator',
        'system',
        'internal',
        'other',
      ].includes(row.sqlStateClass as string | null)
    )
      throw new Basic5CiHold('utility_child_diagnostic_malformed');
    return Object.fromEntries(
      [
        ...keys,
        ...('censusDiagnostic' in row ? ['censusDiagnostic'] : []),
        ...('closureProof' in row ? ['closureProof'] : []),
      ].map((key) => [key, row[key]]),
    ) as unknown as Basic5CiUtilityChildDiagnostic;
  });
}

export type Basic5CiCaseEntryDiagnostic = {
  stage:
    | 'process_registry_precheck'
    | 'vitest_config_generation'
    | 'vitest_entry_resolution'
    | 'vitest_child_execution'
    | 'vitest_output_parse';
  category: Basic5CiPreparationDiagnostic['category'];
};

export type Basic5CiBuildDiagnostic = {
  checks: Record<string, boolean>;
  observed: {
    runtimeInventoryEntryCount: number | null;
    runtimeInventoryFileCount: number | null;
    runtimeInventorySymlinkCount: number | null;
    runtimeInventoryBytes: number | null;
    staticAssetsFileCount: number | null;
    publicAssetsFileCount: number | null;
  };
};

const BUILD_DIAGNOSTIC_CHECK_KEYS = [
  'sourceCommitMatches',
  'sourceWebTreeMatches',
  'nodeVersionMatches',
  'imageOSMatches',
  'imageVersionMatches',
  'buildIdPresent',
  'buildIdSha256Valid',
  'serverSha256Valid',
  'runtimeInventorySha256Valid',
  'limitationsArray',
  'limitationsCountBounded',
  'limitationsItemsBounded',
  'runtimeInventoryEntryCountPositive',
  'runtimeInventoryFileCountPositive',
  'runtimeInventorySymlinkCountValid',
  'runtimeInventoryBytesPositive',
  'staticAssetsPresent',
  'staticAssetsNonempty',
  'staticAssetsSha256Valid',
  'publicAssetsPresent',
  'publicAssetsNonempty',
  'publicAssetsSha256Valid',
] as const;
const BUILD_DIAGNOSTIC_COUNT_KEYS = [
  'runtimeInventoryEntryCount',
  'runtimeInventoryFileCount',
  'runtimeInventorySymlinkCount',
  'runtimeInventoryBytes',
  'staticAssetsFileCount',
  'publicAssetsFileCount',
] as const;

type LinuxSnapshot = {
  state?: string;
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  startTimeTicks: string;
};
type LinuxIdentity = LinuxSnapshot & { exe: string };
export type Basic5CiProcessSnapshot = LinuxSnapshot;
type RegistryRecord = LinuxIdentity & {
  version: 1;
  role: 'fixture-worker' | 'web' | 'browser' | 'embedding';
  port?: number;
};
type ProcessProof = {
  BASIC5_CI_CHROME_EXECUTABLE: string;
  readBasic5LinuxProcessSnapshot(): Promise<Map<number, LinuxSnapshot>>;
  readBasic5LinuxProcessIdentity(
    pid: number,
    enrolled?: LinuxIdentity,
  ): Promise<LinuxIdentity | undefined>;
  readBasic5CiProcessRegistry(path: string): Promise<RegistryRecord[]>;
  assertBasic5CiProcessRegistryComplete(records: readonly RegistryRecord[]): void;
  assertBasic5CiProcessClosure(
    records: readonly RegistryRecord[],
    live: ReadonlyMap<number, LinuxSnapshot>,
    ports: ReadonlySet<number>,
  ): void;
};

export type Basic5CiUtilityChildTestDriver = {
  repositoryRoot?: string;
  spawn: typeof spawn;
  metadataExec?: MetadataExecFile;
  proof: ProcessProof;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
};
type BuildProvenanceModule = {
  observeBasic5CiBuildProvenance(input: {
    repositoryRoot: string;
    artifactRoot: string;
    serverRoot: string;
    sourceCommit: string;
    sourceWebTree: string;
    nodeVersion: string;
    imageOS: string;
    imageVersion: string;
    collectTraceDiagnostic: false;
  }): Promise<{
    source: { commit: string; webTree: string };
    requiredArtifactIdentity: {
      buildId: string;
      buildIdSha256: string;
      serverSha256: string;
      runtimeInventorySha256: string;
      runtimeInventoryEntryCount: number;
      runtimeInventoryFileCount: number;
      runtimeInventorySymlinkCount: number;
      runtimeInventoryBytes: number;
      staticAssets: { present: true; fileCount: number; sha256: string };
      publicAssets: { present: true; fileCount: number; sha256: string };
    };
    runtime: { nodeVersion: string; imageOS: string; imageVersion: string };
    diagnosticTraceCompleteness: {
      scope: 'apps/web/.next/server';
      collection: 'not_requested';
      status: 'not_collected';
      manifestCount: null;
      manifestBytes: null;
      manifestSha256: null;
      referenceCount: null;
      resolvedCheckoutReferenceCount: null;
      matchedClosureContentCount: null;
      unmatchedReferenceCount: null;
    };
    buildExecutionAttribution: string;
    limitations: readonly string[];
  }>;
};
type TargetSupport = {
  allocateTestTarget(source: string, token?: string, kind?: 'standard' | 'restore'): Basic5CiTarget;
  assertAllocatedTestTargetMarker(input: {
    databaseUrl?: string;
    testDatabaseUrl?: string;
    token?: string;
    kind?: 'standard' | 'restore';
  }): Basic5CiTarget;
  assertAllocatedTestDatabaseOwnership(
    db: unknown,
    target: Pick<Basic5CiTarget, 'databaseName' | 'token'>,
  ): Promise<void>;
  testTargetMarkerPath(token: string): string;
};
type DbModule = {
  createDb(
    url: string,
    options?: Record<string, unknown>,
  ): {
    $client: {
      unsafe(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
      end(options?: { timeout?: number }): Promise<void>;
    };
  };
};

/** The injectable seam is intentionally specific to this one CI acceptance case. */
export interface Basic5CiOps {
  now(): number;
  preflight(deadline: number, signal: AbortSignal): Promise<Basic5CiPreflight>;
  prepareFreshTarget(deadline: number, signal: AbortSignal): Promise<Basic5CiTarget>;
  runExactCase(
    target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Basic5CiCaseResult>;
  quiesceApplication(deadline: number, signal: AbortSignal): Promise<Basic5CiQuiescence>;
  cleanupExactTarget(target: Basic5CiTarget, deadline: number, signal: AbortSignal): Promise<void>;
  currentPreparationStage?(): Basic5CiPreparationDiagnostic['stage'] | undefined;
  currentCaseEntryStage?(): Basic5CiCaseEntryDiagnostic['stage'] | undefined;
  verifyTargetAbsent(
    target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  writeContentFreeReceipt(receipt: Record<string, unknown>, signal: AbortSignal): Promise<void>;
}

export interface Basic5CiDeadlineTimers {
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}

export class Basic5CiHold extends Error {
  constructor(
    readonly code: string,
    readonly operationSettled = true,
    readonly buildDiagnostic?: Basic5CiBuildDiagnostic,
    readonly chromeVersionDiagnostic?: Basic5CiChromeVersionDiagnostic,
    readonly preparationDiagnostic?: Basic5CiPreparationDiagnostic,
    readonly caseEntryDiagnostic?: Basic5CiCaseEntryDiagnostic,
    readonly utilityChildDiagnostic?: Basic5CiUtilityChildDiagnostic,
    readonly vitestDiagnostic?: Basic5CiVitestDiagnostic,
  ) {
    super(code);
  }
}

class Basic5CiCensusHold extends Basic5CiHold {
  constructor(
    readonly censusDiagnostic: Basic5CiCensusDiagnostic,
    code = 'owned_session_census_unverified',
  ) {
    super(code, false);
  }
}

function censusFailure(
  stage: Basic5CiCensusDiagnostic['stage'],
  error: unknown,
): Basic5CiCensusHold {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const reason = CENSUS_REASONS.find((known) => known === code) ?? 'helper_unclassified';
  return new Basic5CiCensusHold({ stage, reason });
}

function changedProcessFact(
  expected: LinuxSnapshot,
  actual: LinuxSnapshot,
): Basic5CiCensusDiagnostic['reason'] | undefined {
  if (actual.startTimeTicks !== expected.startTimeTicks) return 'generation_changed';
  if (actual.ppid !== expected.ppid) return 'parent_changed';
  if (actual.pgid !== expected.pgid) return 'group_changed';
  if (actual.sid !== expected.sid) return 'session_changed';
  return undefined;
}

export async function runBasic5CiCaseEntryStep<T>(
  stage: Basic5CiCaseEntryDiagnostic['stage'],
  failureCode: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const hold = error instanceof Basic5CiHold ? error : undefined;
    throw new Basic5CiHold(
      hold?.code ?? failureCode,
      hold?.operationSettled ?? true,
      hold?.buildDiagnostic,
      hold?.chromeVersionDiagnostic,
      hold?.preparationDiagnostic,
      { stage, category: classifyPreparationError(error) },
      hold?.utilityChildDiagnostic,
      hold?.vitestDiagnostic,
    );
  }
}

export async function runBasic5CiPreparationStep<T>(
  stage: Basic5CiPreparationDiagnostic['stage'],
  failureCode: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const hold = error instanceof Basic5CiHold ? error : undefined;
    throw new Basic5CiHold(
      hold?.code ?? failureCode,
      hold?.operationSettled ?? true,
      hold?.buildDiagnostic,
      hold?.chromeVersionDiagnostic,
      { stage, category: classifyPreparationError(error) },
      undefined,
      hold?.utilityChildDiagnostic,
      hold?.vitestDiagnostic,
    );
  }
}

function classifyPreparationError(error: unknown): Basic5CiPreparationDiagnostic['category'] {
  if (error instanceof Basic5CiHold) return 'controller_hold';
  if (!error || typeof error !== 'object') return 'operation_error';
  const safeError = error as { code?: unknown; name?: unknown };
  if (
    [
      'ERR_MODULE_NOT_FOUND',
      'MODULE_NOT_FOUND',
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      'ERR_UNKNOWN_FILE_EXTENSION',
    ].includes(String(safeError.code))
  )
    return 'module_resolution';
  if (safeError.code === 'ENOENT') return 'filesystem_missing';
  if (safeError.code === 'EACCES' || safeError.code === 'EPERM') return 'permission_denied';
  if (safeError.name === 'TypeError') return 'type_error';
  if (safeError.name === 'SyntaxError') return 'syntax_error';
  return 'operation_error';
}

export function combineBasic5CiPreparationFailures(
  primary: Basic5CiHold,
  secondary: Basic5CiHold,
): Basic5CiHold {
  const primaryDiagnostic = primary.preparationDiagnostic;
  const secondaryDiagnostic = secondary.preparationDiagnostic;
  const preparationDiagnostic =
    primaryDiagnostic && secondaryDiagnostic
      ? {
          ...primaryDiagnostic,
          secondaryStage: secondaryDiagnostic.stage,
          secondaryCategory: secondaryDiagnostic.category,
        }
      : (primaryDiagnostic ?? secondaryDiagnostic);
  return new Basic5CiHold(
    primary.code,
    primary.operationSettled && secondary.operationSettled,
    primary.buildDiagnostic,
    primary.chromeVersionDiagnostic,
    preparationDiagnostic,
    undefined,
    primary.utilityChildDiagnostic ?? secondary.utilityChildDiagnostic,
  );
}

function contentFreePreparationDiagnostic(value: unknown): Basic5CiPreparationDiagnostic {
  const stages: Basic5CiPreparationDiagnostic['stage'][] = [
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
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![2, 4].includes(Object.keys(value).length) ||
    !stages.includes(
      (value as Record<string, unknown>).stage as Basic5CiPreparationDiagnostic['stage'],
    ) ||
    ![
      'controller_hold',
      'module_resolution',
      'type_error',
      'syntax_error',
      'filesystem_missing',
      'permission_denied',
      'phase_deadline_or_unsettled',
      'operation_error',
    ].includes(String((value as Record<string, unknown>).category)) ||
    Object.hasOwn(value, 'secondaryStage') !== Object.hasOwn(value, 'secondaryCategory') ||
    (Object.hasOwn(value, 'secondaryStage') &&
      (!stages.includes(
        (value as Record<string, unknown>).secondaryStage as Basic5CiPreparationDiagnostic['stage'],
      ) ||
        ![
          'controller_hold',
          'module_resolution',
          'type_error',
          'syntax_error',
          'filesystem_missing',
          'permission_denied',
          'phase_deadline_or_unsettled',
          'operation_error',
        ].includes(String((value as Record<string, unknown>).secondaryCategory))))
  )
    throw new Basic5CiHold('preparation_diagnostic_invalid');
  const diagnostic = value as Basic5CiPreparationDiagnostic;
  return {
    stage: diagnostic.stage,
    category: diagnostic.category,
    ...(diagnostic.secondaryStage
      ? {
          secondaryStage: diagnostic.secondaryStage,
          secondaryCategory: diagnostic.secondaryCategory,
        }
      : {}),
  };
}

function contentFreeCaseEntryDiagnostic(value: unknown): Basic5CiCaseEntryDiagnostic {
  const stages: Basic5CiCaseEntryDiagnostic['stage'][] = [
    'process_registry_precheck',
    'vitest_config_generation',
    'vitest_entry_resolution',
    'vitest_child_execution',
    'vitest_output_parse',
  ];
  const categories: Basic5CiPreparationDiagnostic['category'][] = [
    'controller_hold',
    'module_resolution',
    'type_error',
    'syntax_error',
    'filesystem_missing',
    'permission_denied',
    'phase_deadline_or_unsettled',
    'operation_error',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !stages.includes(
      (value as Record<string, unknown>).stage as Basic5CiCaseEntryDiagnostic['stage'],
    ) ||
    !categories.includes(
      (value as Record<string, unknown>).category as Basic5CiPreparationDiagnostic['category'],
    )
  )
    throw new Basic5CiHold('case_entry_diagnostic_invalid');
  const diagnostic = value as Basic5CiCaseEntryDiagnostic;
  return { stage: diagnostic.stage, category: diagnostic.category };
}

/** Parse only the bounded version banner; output bytes themselves are never retained. */
export function observeBasic5CiChromeVersion(result: {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}): { version: string | null; diagnostic: Basic5CiChromeVersionDiagnostic } {
  const stdoutBytes = Math.min(result.stdout.byteLength, CAPTURE_BYTES);
  const stderrBytes = Math.min(result.stderr.byteLength, CAPTURE_BYTES);
  const common = { exitCode: result.exitCode, stdoutBytes, stderrBytes };
  if (result.stdout.byteLength + result.stderr.byteLength > CAPTURE_BYTES)
    return { version: null, diagnostic: { status: 'capture_limit', ...common } };
  if (result.exitCode !== 0)
    return { version: null, diagnostic: { status: 'nonzero_exit', ...common } };
  // Chrome prints a separator before its channel, even when that channel is empty.
  // Normalize only ASCII line-edge spacing and one terminal line ending.
  const banner = result.stdout
    .toString('utf8')
    .replace(/\r?\n$/, '')
    .replace(/^[ \t]+|[ \t]+$/g, '');
  const match = banner.match(
    /^Google Chrome(?: for Testing)? ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$(?![\s\S])/,
  );
  if (!match?.[1])
    return { version: null, diagnostic: { status: 'version_unparseable', ...common } };
  return { version: match[1], diagnostic: { status: 'accepted', ...common } };
}

function chromeVersionFailureDiagnostic(
  status: 'spawn_or_timeout' | 'capture_limit',
): Basic5CiChromeVersionDiagnostic {
  return { status, exitCode: null, stdoutBytes: null, stderrBytes: null };
}

function contentFreeChromeVersionDiagnostic(value: unknown): Basic5CiChromeVersionDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold('chrome_version_diagnostic_invalid');
  const diagnostic = value as Record<string, unknown>;
  if (
    Object.keys(diagnostic).length !== 4 ||
    ![
      'accepted',
      'nonzero_exit',
      'version_unparseable',
      'spawn_or_timeout',
      'capture_limit',
    ].includes(String(diagnostic.status)) ||
    (diagnostic.exitCode !== null &&
      (!Number.isSafeInteger(diagnostic.exitCode) || Number(diagnostic.exitCode) < 0)) ||
    (diagnostic.stdoutBytes !== null &&
      (!Number.isSafeInteger(diagnostic.stdoutBytes) ||
        Number(diagnostic.stdoutBytes) < 0 ||
        Number(diagnostic.stdoutBytes) > CAPTURE_BYTES)) ||
    (diagnostic.stderrBytes !== null &&
      (!Number.isSafeInteger(diagnostic.stderrBytes) ||
        Number(diagnostic.stderrBytes) < 0 ||
        Number(diagnostic.stderrBytes) > CAPTURE_BYTES)) ||
    (diagnostic.status === 'spawn_or_timeout' &&
      (diagnostic.exitCode !== null ||
        diagnostic.stdoutBytes !== null ||
        diagnostic.stderrBytes !== null)) ||
    (diagnostic.status === 'accepted' &&
      (diagnostic.exitCode !== 0 ||
        diagnostic.stdoutBytes === null ||
        diagnostic.stderrBytes === null)) ||
    (diagnostic.status === 'nonzero_exit' &&
      (diagnostic.exitCode === null ||
        diagnostic.exitCode === 0 ||
        diagnostic.stdoutBytes === null ||
        diagnostic.stderrBytes === null)) ||
    (diagnostic.status === 'version_unparseable' &&
      (diagnostic.exitCode !== 0 ||
        diagnostic.stdoutBytes === null ||
        diagnostic.stderrBytes === null)) ||
    (diagnostic.status === 'capture_limit' &&
      !(
        diagnostic.exitCode === null &&
        diagnostic.stdoutBytes === null &&
        diagnostic.stderrBytes === null
      ) &&
      !(
        Number.isSafeInteger(diagnostic.exitCode) &&
        diagnostic.stdoutBytes !== null &&
        diagnostic.stderrBytes !== null &&
        (Number(diagnostic.stdoutBytes) + Number(diagnostic.stderrBytes) > CAPTURE_BYTES ||
          Number(diagnostic.stdoutBytes) === CAPTURE_BYTES ||
          Number(diagnostic.stderrBytes) === CAPTURE_BYTES)
      ))
  )
    throw new Basic5CiHold('chrome_version_diagnostic_invalid');
  return {
    status: diagnostic.status as Basic5CiChromeVersionDiagnostic['status'],
    exitCode: diagnostic.exitCode as number | null,
    stdoutBytes: diagnostic.stdoutBytes as number | null,
    stderrBytes: diagnostic.stderrBytes as number | null,
  };
}

export function assertBasic5CiWorkflowAdmission(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_WORKFLOW !== 'CI' ||
    environment.GITHUB_EVENT_NAME !== 'push' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[a-f0-9]{40}$/i.test(environment.GITHUB_WORKFLOW_SHA ?? '') ||
    environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
    environment.ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE !== '1'
  )
    throw new Basic5CiHold('workflow_admission_context_not_authorized');
}

function boundedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= 2 * 1024 * 1024 * 1024
    ? (value as number)
    : null;
}

function contentFreeBuildDiagnostic(value: unknown): Basic5CiBuildDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold('standalone_diagnostic_invalid');
  const diagnostic = value as Record<string, unknown>;
  if (
    Object.keys(diagnostic).length !== 2 ||
    !('checks' in diagnostic) ||
    !('observed' in diagnostic)
  )
    throw new Basic5CiHold('standalone_diagnostic_invalid');
  const checks = diagnostic.checks;
  const observed = diagnostic.observed;
  if (
    !checks ||
    typeof checks !== 'object' ||
    Array.isArray(checks) ||
    !observed ||
    typeof observed !== 'object' ||
    Array.isArray(observed)
  )
    throw new Basic5CiHold('standalone_diagnostic_invalid');
  const rawChecks = checks as Record<string, unknown>;
  const rawObserved = observed as Record<string, unknown>;
  if (
    Object.keys(rawChecks).length !== BUILD_DIAGNOSTIC_CHECK_KEYS.length ||
    BUILD_DIAGNOSTIC_CHECK_KEYS.some((key) => typeof rawChecks[key] !== 'boolean') ||
    Object.keys(rawChecks).some(
      (key) =>
        !BUILD_DIAGNOSTIC_CHECK_KEYS.includes(key as (typeof BUILD_DIAGNOSTIC_CHECK_KEYS)[number]),
    ) ||
    Object.keys(rawObserved).length !== BUILD_DIAGNOSTIC_COUNT_KEYS.length ||
    BUILD_DIAGNOSTIC_COUNT_KEYS.some((key) => {
      const count = rawObserved[key];
      return count !== null && boundedCount(count) === null;
    })
  )
    throw new Basic5CiHold('standalone_diagnostic_invalid');
  return {
    checks: Object.fromEntries(
      BUILD_DIAGNOSTIC_CHECK_KEYS.map((key) => [key, rawChecks[key] as boolean]),
    ),
    observed: {
      ...Object.fromEntries(
        BUILD_DIAGNOSTIC_COUNT_KEYS.map((key) => [key, rawObserved[key] as number | null]),
      ),
    } as Basic5CiBuildDiagnostic['observed'],
  };
}

function contentFreeRequiredArtifactIdentity(
  value: unknown,
): Basic5CiPreflight['requiredArtifactIdentity'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold('required_artifact_identity_invalid');
  const identity = value as Record<string, unknown>;
  const identityKeys = [
    'buildId',
    'buildIdSha256',
    'serverSha256',
    'runtimeInventorySha256',
    'runtimeInventoryEntryCount',
    'runtimeInventoryFileCount',
    'runtimeInventorySymlinkCount',
    'runtimeInventoryBytes',
    'staticAssets',
    'publicAssets',
  ];
  if (
    Object.keys(identity).length !== identityKeys.length ||
    Object.keys(identity).some((key) => !identityKeys.includes(key)) ||
    typeof identity.buildId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(identity.buildId) ||
    !/^[a-f0-9]{64}$/.test(String(identity.buildIdSha256)) ||
    !/^[a-f0-9]{64}$/.test(String(identity.serverSha256)) ||
    !/^[a-f0-9]{64}$/.test(String(identity.runtimeInventorySha256)) ||
    !Number.isSafeInteger(identity.runtimeInventoryEntryCount) ||
    Number(identity.runtimeInventoryEntryCount) < 1 ||
    !Number.isSafeInteger(identity.runtimeInventoryFileCount) ||
    Number(identity.runtimeInventoryFileCount) < 1 ||
    !Number.isSafeInteger(identity.runtimeInventorySymlinkCount) ||
    Number(identity.runtimeInventorySymlinkCount) < 0 ||
    !Number.isSafeInteger(identity.runtimeInventoryBytes) ||
    Number(identity.runtimeInventoryBytes) < 1
  )
    throw new Basic5CiHold('required_artifact_identity_invalid');
  const asset = (raw: unknown, label: string) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Basic5CiHold(`${label}_identity_invalid`);
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      Object.keys(row).some((key) => !['present', 'fileCount', 'sha256'].includes(key)) ||
      row.present !== true ||
      !Number.isSafeInteger(row.fileCount) ||
      Number(row.fileCount) < 1 ||
      !/^[a-f0-9]{64}$/.test(String(row.sha256))
    )
      throw new Basic5CiHold(`${label}_identity_invalid`);
    return {
      present: true as const,
      fileCount: Number(row.fileCount),
      sha256: row.sha256 as string,
    };
  };
  return {
    buildId: identity.buildId,
    buildIdSha256: identity.buildIdSha256 as string,
    serverSha256: identity.serverSha256 as string,
    runtimeInventorySha256: identity.runtimeInventorySha256 as string,
    runtimeInventoryEntryCount: Number(identity.runtimeInventoryEntryCount),
    runtimeInventoryFileCount: Number(identity.runtimeInventoryFileCount),
    runtimeInventorySymlinkCount: Number(identity.runtimeInventorySymlinkCount),
    runtimeInventoryBytes: Number(identity.runtimeInventoryBytes),
    staticAssets: asset(identity.staticAssets, 'static_assets'),
    publicAssets: asset(identity.publicAssets, 'public_assets'),
  };
}

function contentFreeTraceDiagnostic(
  value: unknown,
): Basic5CiPreflight['diagnosticTraceCompleteness'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold('trace_diagnostic_invalid');
  const diagnostic = value as Record<string, unknown>;
  const keys = [
    'scope',
    'collection',
    'status',
    'manifestCount',
    'manifestBytes',
    'manifestSha256',
    'referenceCount',
    'resolvedCheckoutReferenceCount',
    'matchedClosureContentCount',
    'unmatchedReferenceCount',
  ];
  if (
    Object.keys(diagnostic).length !== keys.length ||
    Object.keys(diagnostic).some((key) => !keys.includes(key)) ||
    diagnostic.scope !== 'apps/web/.next/server' ||
    !['not_requested', 'collected'].includes(String(diagnostic.collection)) ||
    !['not_collected', 'complete', 'incomplete', 'unavailable'].includes(String(diagnostic.status))
  )
    throw new Basic5CiHold('trace_diagnostic_invalid');
  const countKeys = [
    'manifestCount',
    'manifestBytes',
    'referenceCount',
    'resolvedCheckoutReferenceCount',
    'matchedClosureContentCount',
    'unmatchedReferenceCount',
  ];
  if (diagnostic.status === 'not_collected') {
    if (
      diagnostic.collection !== 'not_requested' ||
      diagnostic.manifestSha256 !== null ||
      countKeys.some((key) => diagnostic[key] !== null)
    )
      throw new Basic5CiHold('trace_diagnostic_unknown_must_remain_null');
  } else if (
    diagnostic.collection !== 'collected' ||
    countKeys.some(
      (key) => !Number.isSafeInteger(diagnostic[key]) || Number(diagnostic[key]) < 0,
    ) ||
    (diagnostic.manifestSha256 !== null &&
      !/^[a-f0-9]{64}$/.test(String(diagnostic.manifestSha256)))
  ) {
    throw new Basic5CiHold('trace_diagnostic_collected_shape_invalid');
  }
  return {
    scope: 'apps/web/.next/server',
    collection: diagnostic.collection as 'not_requested' | 'collected',
    status: diagnostic.status as Basic5CiPreflight['diagnosticTraceCompleteness']['status'],
    manifestCount: diagnostic.manifestCount as number | null,
    manifestBytes: diagnostic.manifestBytes as number | null,
    manifestSha256: diagnostic.manifestSha256 as string | null,
    referenceCount: diagnostic.referenceCount as number | null,
    resolvedCheckoutReferenceCount: diagnostic.resolvedCheckoutReferenceCount as number | null,
    matchedClosureContentCount: diagnostic.matchedClosureContentCount as number | null,
    unmatchedReferenceCount: diagnostic.unmatchedReferenceCount as number | null,
  };
}

function contentFreeWorkflowContext(value: unknown): Basic5CiPreflight['workflowContext'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold('workflow_context_invalid');
  const workflow = value as Record<string, unknown>;
  if (
    Object.keys(workflow).length !== 7 ||
    Object.keys(workflow).some(
      (key) =>
        ![
          'event',
          'ref',
          'runAttempt',
          'frozenLockfileInstallAndBuildSucceeded',
          'frozenLockfileBuildBasis',
          'workflowSha',
          'lockfileSha256',
        ].includes(key),
    ) ||
    workflow.event !== 'push' ||
    workflow.ref !== 'refs/heads/main' ||
    workflow.runAttempt !== 1 ||
    workflow.frozenLockfileInstallAndBuildSucceeded !== true ||
    workflow.frozenLockfileBuildBasis !== 'ordered_ci_steps_completed_before_acceptance' ||
    !/^[a-f0-9]{40}$/i.test(String(workflow.workflowSha)) ||
    !/^[a-f0-9]{64}$/.test(String(workflow.lockfileSha256))
  )
    throw new Basic5CiHold('workflow_context_invalid');
  return {
    event: 'push',
    ref: 'refs/heads/main',
    runAttempt: 1,
    frozenLockfileInstallAndBuildSucceeded: true,
    frozenLockfileBuildBasis: 'ordered_ci_steps_completed_before_acceptance',
    workflowSha: workflow.workflowSha as string,
    lockfileSha256: workflow.lockfileSha256 as string,
  };
}

function buildProvenanceDiagnostic(
  provenance: Awaited<ReturnType<BuildProvenanceModule['observeBasic5CiBuildProvenance']>>,
  expected: {
    sourceCommit: string;
    sourceWebTree: string;
    nodeVersion: string;
    imageOS: string;
    imageVersion: string;
  },
): Basic5CiBuildDiagnostic {
  const limitationsValid =
    Array.isArray(provenance.limitations) &&
    provenance.limitations.every((item) => typeof item === 'string' && item.length <= 500);
  const checks = {
    sourceCommitMatches: provenance.source.commit === expected.sourceCommit,
    sourceWebTreeMatches: provenance.source.webTree === expected.sourceWebTree,
    nodeVersionMatches: provenance.runtime.nodeVersion === expected.nodeVersion,
    imageOSMatches: provenance.runtime.imageOS === expected.imageOS,
    imageVersionMatches: provenance.runtime.imageVersion === expected.imageVersion,
    buildIdPresent:
      typeof provenance.requiredArtifactIdentity.buildId === 'string' &&
      provenance.requiredArtifactIdentity.buildId.length > 0,
    buildIdSha256Valid: /^[a-f0-9]{64}$/.test(provenance.requiredArtifactIdentity.buildIdSha256),
    serverSha256Valid: /^[a-f0-9]{64}$/.test(provenance.requiredArtifactIdentity.serverSha256),
    runtimeInventorySha256Valid: /^[a-f0-9]{64}$/.test(
      provenance.requiredArtifactIdentity.runtimeInventorySha256,
    ),
    limitationsArray: Array.isArray(provenance.limitations),
    limitationsCountBounded:
      Array.isArray(provenance.limitations) && provenance.limitations.length <= 16,
    limitationsItemsBounded: limitationsValid,
    runtimeInventoryEntryCountPositive:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.runtimeInventoryEntryCount) &&
      provenance.requiredArtifactIdentity.runtimeInventoryEntryCount >= 1,
    runtimeInventoryFileCountPositive:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.runtimeInventoryFileCount) &&
      provenance.requiredArtifactIdentity.runtimeInventoryFileCount >= 1,
    runtimeInventorySymlinkCountValid:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.runtimeInventorySymlinkCount) &&
      provenance.requiredArtifactIdentity.runtimeInventorySymlinkCount >= 0,
    runtimeInventoryBytesPositive:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.runtimeInventoryBytes) &&
      provenance.requiredArtifactIdentity.runtimeInventoryBytes >= 1,
    staticAssetsPresent: provenance.requiredArtifactIdentity.staticAssets.present === true,
    staticAssetsNonempty:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.staticAssets.fileCount) &&
      provenance.requiredArtifactIdentity.staticAssets.fileCount > 0,
    staticAssetsSha256Valid: /^[a-f0-9]{64}$/.test(
      provenance.requiredArtifactIdentity.staticAssets.sha256,
    ),
    publicAssetsPresent: provenance.requiredArtifactIdentity.publicAssets.present === true,
    publicAssetsNonempty:
      Number.isSafeInteger(provenance.requiredArtifactIdentity.publicAssets.fileCount) &&
      provenance.requiredArtifactIdentity.publicAssets.fileCount > 0,
    publicAssetsSha256Valid: /^[a-f0-9]{64}$/.test(
      provenance.requiredArtifactIdentity.publicAssets.sha256,
    ),
  };
  return {
    checks,
    observed: {
      runtimeInventoryEntryCount: boundedCount(
        provenance.requiredArtifactIdentity.runtimeInventoryEntryCount,
      ),
      runtimeInventoryFileCount: boundedCount(
        provenance.requiredArtifactIdentity.runtimeInventoryFileCount,
      ),
      runtimeInventorySymlinkCount: boundedCount(
        provenance.requiredArtifactIdentity.runtimeInventorySymlinkCount,
      ),
      runtimeInventoryBytes: boundedCount(
        provenance.requiredArtifactIdentity.runtimeInventoryBytes,
      ),
      staticAssetsFileCount: boundedCount(
        provenance.requiredArtifactIdentity.staticAssets.fileCount,
      ),
      publicAssetsFileCount: boundedCount(
        provenance.requiredArtifactIdentity.publicAssets.fileCount,
      ),
    },
  };
}

function contentFreeQuiescence(value: Basic5CiQuiescence): Basic5CiQuiescence {
  return {
    known: value.known,
    registeredRoles: [...value.registeredRoles],
    liveOwnedProcesses: value.liveOwnedProcesses,
    liveOwnedListeners: value.liveOwnedListeners,
    unknownProcesses: value.unknownProcesses,
    fixtureRegistryValid: value.fixtureRegistryValid,
  };
}

export function parseLinuxListenTable(tcp: string, tcp6: string): Map<string, number> {
  const listeners = new Map<string, number>();
  const parseFile = (raw: string, family: 4 | 6): void => {
    const lines = raw.split('\n');
    if (!lines[0]?.includes('local_address') || !lines[0]?.includes('st'))
      throw new Basic5CiHold('linux_listener_table_header_unknown');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) throw new Basic5CiHold('linux_listener_table_row_unknown');
      if (fields[3] !== '0A') continue;
      const [hexAddress, hexPort, extra] = (fields[1] ?? '').split(':');
      const expectedLength = family === 4 ? 8 : 32;
      if (
        !hexAddress ||
        !hexPort ||
        extra !== undefined ||
        hexAddress.length !== expectedLength ||
        !/^[0-9a-f]+$/i.test(hexAddress) ||
        !/^[0-9a-f]{4}$/i.test(hexPort)
      )
        throw new Basic5CiHold('linux_listener_address_unknown');
      let address: string;
      if (family === 4) {
        address = (hexAddress.match(/../g) ?? [])
          .reverse()
          .map((byte) => String(parseInt(byte, 16)))
          .join('.');
      } else {
        const words = (hexAddress.match(/.{8}/g) ?? []).map((word) =>
          (word.match(/../g) ?? []).reverse().join(''),
        );
        address = words.join(':').toLowerCase();
      }
      const port = Number.parseInt(hexPort, 16);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Basic5CiHold('linux_listener_port_unknown');
      const key = `${family}:${address}:${port}`;
      if (listeners.has(key)) throw new Basic5CiHold('linux_listener_duplicate');
      listeners.set(key, port);
    }
  };
  parseFile(tcp, 4);
  parseFile(tcp6, 6);
  return listeners;
}

export function ownedSessionEnrollmentOrder(
  snapshot: ReadonlyMap<number, Basic5CiProcessSnapshot>,
  sessionId: number,
  alreadyOwned: ReadonlySet<number>,
): number[] {
  const pending = [...snapshot.values()].filter(
    (row) => row.sid === sessionId && !alreadyOwned.has(row.pid),
  );
  const enrolled = new Set(alreadyOwned);
  const order: number[] = [];
  while (pending.length > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const row = pending[index];
      if (!row || !enrolled.has(row.ppid)) continue;
      enrolled.add(row.pid);
      order.push(row.pid);
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) throw new Basic5CiHold('unregistered_process_inside_owned_session');
  }
  return order;
}

type MetadataExecOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: 'buffer';
  maxBuffer: number;
  timeout: number;
  killSignal: 'SIGKILL';
  signal?: AbortSignal;
};
type MetadataExecFile = (
  command: string,
  args: string[],
  options: MetadataExecOptions,
  callback: (error: unknown, stdout: Buffer, stderr: Buffer) => void,
) => unknown;

/** Bounded fast-exit adapter for explicitly read-only preflight metadata commands. */
export function runBasic5CiReadOnlyMetadata(
  command: string,
  args: string[],
  options: MetadataExecOptions,
  deadline: number,
  now: () => number,
  execute: MetadataExecFile = execFile as MetadataExecFile,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const allowedGit =
    command === 'git' &&
    [
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['rev-parse', 'HEAD:apps/web'],
    ].some((known) => JSON.stringify(known) === JSON.stringify(args));
  const allowedChrome =
    command === '/opt/google/chrome/chrome' &&
    JSON.stringify(args) === JSON.stringify(['--version']);
  if (!allowedGit && !allowedChrome)
    return Promise.reject(new Basic5CiHold('metadata_command_not_allowlisted'));
  if (!Number.isFinite(deadline) || deadline <= now())
    return Promise.reject(new Basic5CiHold('metadata_command_deadline'));
  return new Promise((resolve, reject) => {
    const timeout = Math.min(5_000, Math.floor(deadline - now()));
    if (timeout <= 0) {
      reject(new Basic5CiHold('metadata_command_deadline'));
      return;
    }
    try {
      execute(
        command,
        args,
        { ...options, timeout, maxBuffer: CAPTURE_BYTES, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > CAPTURE_BYTES) {
            reject(new Basic5CiHold('metadata_command_capture_limit'));
            return;
          }
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new Basic5CiHold('metadata_command_capture_limit'));
            return;
          }
          if (error && !Number.isSafeInteger(code)) {
            reject(new Basic5CiHold('metadata_command_failed_or_timed_out'));
            return;
          }
          resolve({ exitCode: error ? Number(code) : 0, stdout, stderr });
        },
      );
    } catch {
      reject(new Basic5CiHold('metadata_command_start_failed'));
    }
  });
}

export interface Basic5CiDirectChildHandle {
  pid?: number;
  stdout?: unknown;
  stderr?: unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export async function settleDirectChildHandle(
  child: Basic5CiDirectChildHandle,
  closed: Promise<void>,
  timeoutMs = 1_500,
): Promise<boolean> {
  if (Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The close event below determines whether the direct child settled.
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function verifyDirectChildBootstrap(
  child: Basic5CiDirectChildHandle,
  parentPid: number,
  readIdentity: (pid: number) => Promise<LinuxIdentity | undefined>,
  closed: Promise<void>,
  settleOnFailure = true,
): Promise<LinuxIdentity> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || !child.stdout || !child.stderr) {
    if (settleOnFailure) await settleDirectChildHandle(child, closed);
    throw new Basic5CiHold('child_start_unknown', false);
  }
  let identity: LinuxIdentity | undefined;
  try {
    identity = await readIdentity(pid);
  } catch {
    if (settleOnFailure) await settleDirectChildHandle(child, closed);
    throw new Basic5CiHold('child_identity_unavailable', false);
  }
  if (!identity || identity.ppid !== parentPid || identity.pgid !== pid || identity.sid !== pid) {
    if (settleOnFailure) await settleDirectChildHandle(child, closed);
    throw new Basic5CiHold('child_identity_unverified', false);
  }
  return identity;
}

function assertWithin(ops: Basic5CiOps, deadline: number, phase: string): void {
  if (ops.now() > deadline) throw new Basic5CiHold(`${phase}_deadline`);
}

function assertNotAborted(signal: AbortSignal, phase: string): void {
  if (signal.aborted) throw new Basic5CiHold(`${phase}_cancelled`);
}

function runBeforeDeadline<T>(
  ops: Basic5CiOps,
  deadline: number,
  phase: string,
  work: (signal: AbortSignal) => Promise<T>,
  timers: Basic5CiDeadlineTimers,
  settlementGraceMs = PHASE_SETTLEMENT_GRACE_MS,
): Promise<T> {
  const remaining = deadline - ops.now();
  if (remaining <= 0) return Promise.reject(new Basic5CiHold(`${phase}_deadline`));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineFired = false;
  const operation = Promise.resolve().then(() => work(controller.signal));
  const guardedOperation = operation.then(
    (value) => {
      if (deadlineFired) throw new Basic5CiHold(`${phase}_deadline`);
      return value;
    },
    (error: unknown) => {
      if (deadlineFired) {
        if (error instanceof Basic5CiHold && !error.operationSettled) throw error;
        throw new Basic5CiHold(`${phase}_deadline`);
      }
      throw error;
    },
  );
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = timers.schedule(() => {
      deadlineFired = true;
      controller.abort();
      let settled = false;
      const markSettled = () => {
        if (settled) return;
        settled = true;
        if (settlementTimer !== undefined) timers.cancel(settlementTimer);
        reject(new Basic5CiHold(`${phase}_deadline`));
      };
      operation.then(markSettled, markSettled);
      settlementTimer = timers.schedule(() => {
        if (!settled) reject(new Basic5CiHold(`${phase}_operation_unsettled`, false));
      }, settlementGraceMs);
    }, remaining);
  });
  return Promise.race([guardedOperation, timeout]).finally(() => {
    if (timer !== undefined) timers.cancel(timer);
    if (settlementTimer !== undefined) timers.cancel(settlementTimer);
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function requireExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Basic5CiHold(`${label}_shape_invalid`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key)))
    throw new Basic5CiHold(`${label}_keys_invalid`);
}

function validateCiEvidence(
  result: Basic5CiCaseResult,
  target: Basic5CiTarget,
  preflight: Basic5CiPreflight,
): void {
  if (
    result.exitCode !== 0 ||
    result.total !== 1 ||
    result.passed !== 1 ||
    result.skipped !== 0 ||
    result.failed !== 0
  )
    throw new Basic5CiHold('acceptance_requires_exactly_one_pass_and_zero_skips');
  const evidence = result.evidence;
  if (!evidence) throw new Basic5CiHold('acceptance_evidence_missing');
  requireExactKeys(
    evidence,
    [
      'result',
      'standalone',
      'executionEnvironment',
      'fixture',
      'receipts',
      'durableReadbacks',
      'counts',
      'cleanup',
      'externalCleanupSupervisorRequired',
      'standardTestWrapperCleanupIsUnconditional',
      'testFailure',
      'cleanupFailure',
    ],
    'acceptance_evidence',
  );
  requireExactKeys(
    evidence.standalone,
    ['sourceCommit', 'buildId', 'serverSha256'],
    'standalone_evidence',
  );
  requireExactKeys(
    evidence.executionEnvironment,
    ['platform', 'nodeVersion', 'browserChannel', 'browserVersion', 'postgresServerVersionNum'],
    'execution_environment',
  );
  requireExactKeys(
    evidence.fixture,
    [
      'databaseTargetDigest',
      'ownerId',
      'epochPrivacyMatchedReady',
      'baseline',
      'generatedOperationIds',
    ],
    'fixture_evidence',
  );
  requireExactKeys(
    evidence.fixture.baseline,
    ['contactIds', 'entityIds', 'noteId', 'noteHash'],
    'fixture_baseline',
  );
  requireExactKeys(
    evidence.durableReadbacks,
    ['identity', 'familyAdd', 'familyCorrection', 'noteCorrection'],
    'durable_readbacks',
  );
  requireExactKeys(
    evidence.counts,
    [
      'readinessAttempts',
      'pageNavigations',
      'authenticatedPageNavigations',
      'browserHttpRequests',
      'browserControlHttpRequests',
      'browserPresentationHttpRequests',
      'browserPageHttpRequests',
      'anonymousPageProbeRequests',
      'pageApiMutationRequests',
      'applyPosts',
      'ownerEditorPostCount',
      'ownerApplyRequests',
      'recoveryGets',
      'recoveryRequests',
      'embeddingRequests',
      'fixtureModelCalls',
      'foreignModelCalls',
      'providerRequests',
    ],
    'acceptance_counts',
  );
  requireExactKeys(
    evidence.counts.providerRequests,
    ['localEmbeddingHttpRequests', 'fixtureModelCallRows', 'nonFixtureModelCallRows'],
    'provider_request_counts',
  );
  requireExactKeys(
    evidence.cleanup,
    [
      'browserClosed',
      'standaloneProcessGroupExited',
      'embeddingServerClosed',
      'databasePoolClosed',
      'temporaryHomeRemoved',
    ],
    'fixture_cleanup',
  );
  if (!Array.isArray(evidence.receipts)) throw new Basic5CiHold('save_receipts_not_array');
  for (const receipt of evidence.receipts)
    requireExactKeys(
      receipt,
      [
        'authority',
        'command',
        'operationId',
        'requestHash',
        'statusVersion',
        'outcome',
        'uiSavedAfterCleanBaseline',
        'ids',
      ],
      'save_receipt',
    );
  if (evidence.receipts.some((receipt) => receipt.uiSavedAfterCleanBaseline !== true))
    throw new Basic5CiHold('save_receipt_ui_save_evidence_missing');
  if (
    evidence.result !== 'passed' ||
    evidence.testFailure !== null ||
    evidence.cleanupFailure !== null ||
    evidence.externalCleanupSupervisorRequired !== true ||
    evidence.standardTestWrapperCleanupIsUnconditional !== true
  )
    throw new Basic5CiHold('acceptance_evidence_not_successful');
  if (
    evidence.standalone.sourceCommit !== preflight.sourceCommit ||
    evidence.standalone.buildId !== preflight.requiredArtifactIdentity.buildId ||
    evidence.standalone.serverSha256 !== preflight.requiredArtifactIdentity.serverSha256
  )
    throw new Basic5CiHold('standalone_provenance_mismatch');
  const environment = evidence.executionEnvironment;
  if (
    environment.platform !== 'linux' ||
    environment.nodeVersion !== preflight.nodeVersion ||
    !/^v?26\./.test(environment.nodeVersion) ||
    environment.browserChannel !== 'chrome' ||
    !environment.browserVersion ||
    environment.browserVersion !== preflight.chromeVersion ||
    !Number.isSafeInteger(environment.postgresServerVersionNum) ||
    environment.postgresServerVersionNum === null ||
    environment.postgresServerVersionNum < 170000 ||
    environment.postgresServerVersionNum >= 180000 ||
    environment.postgresServerVersionNum !== preflight.postgresServerVersionNum
  )
    throw new Basic5CiHold('execution_environment_observation_mismatch');
  const fixture = evidence.fixture;
  const targetDigest = createHash('sha256').update(target.databaseName).digest('hex').slice(0, 24);
  if (
    fixture.databaseTargetDigest !== targetDigest ||
    !isUuid(fixture.ownerId) ||
    fixture.epochPrivacyMatchedReady !== true ||
    fixture.baseline.contactIds.length !== 2 ||
    fixture.baseline.entityIds.length !== 2 ||
    !fixture.baseline.contactIds.every(isUuid) ||
    !fixture.baseline.entityIds.every(isUuid) ||
    !isUuid(fixture.baseline.noteId) ||
    !/^[a-f0-9]{64}$/.test(fixture.baseline.noteHash) ||
    fixture.generatedOperationIds.length !== 4 ||
    !fixture.generatedOperationIds.every(isUuid)
  )
    throw new Basic5CiHold('synthetic_fixture_identity_or_baseline_invalid');
  if (
    evidence.receipts.length !== ACTIONS.length ||
    evidence.receipts.some(
      (receipt, index) =>
        receipt.command !== ACTIONS[index] ||
        receipt.authority !== 'operation_receipt' ||
        receipt.outcome !== 'saved' ||
        !isUuid(receipt.operationId) ||
        receipt.operationId !== fixture.generatedOperationIds[index] ||
        !/^[a-f0-9]{64}$/.test(receipt.requestHash) ||
        !Number.isSafeInteger(receipt.statusVersion) ||
        receipt.statusVersion < 1,
    ) ||
    new Set(evidence.receipts.map((receipt) => receipt.operationId)).size !== ACTIONS.length
  )
    throw new Basic5CiHold('four_distinct_save_receipts_invalid');
  if (
    evidence.receipts.some(
      (receipt) =>
        receipt.ids !== undefined &&
        receipt.ids !== null &&
        (Object.keys(receipt.ids).some((key) => !RECEIPT_ID_FIELDS.has(key)) ||
          Object.values(receipt.ids).some((value) => !isUuid(value))),
    )
  )
    throw new Basic5CiHold('receipt_contains_non_identifier_or_unknown_field');
  const [identityReceipt, familyAddReceipt, familyCorrectionReceipt, noteCorrectionReceipt] =
    evidence.receipts;
  const identityIds = identityReceipt?.ids;
  const familyAddIds = familyAddReceipt?.ids;
  const familyCorrectionIds = familyCorrectionReceipt?.ids;
  const noteCorrectionIds = noteCorrectionReceipt?.ids;
  if (
    !identityIds ||
    identityIds.contactId !== fixture.baseline.contactIds[0] ||
    !familyAddIds ||
    !isUuid(familyAddIds.relationId) ||
    !isUuid(familyAddIds.memoryId) ||
    !familyCorrectionIds ||
    familyCorrectionIds.previousRelationId !== familyAddIds.relationId ||
    !isUuid(familyCorrectionIds.relationId) ||
    !isUuid(familyCorrectionIds.memoryId) ||
    !noteCorrectionIds ||
    noteCorrectionIds.memoryId !== fixture.baseline.noteId
  )
    throw new Basic5CiHold('save_receipt_identity_or_relationship_lineage_invalid');
  const readbacks = evidence.durableReadbacks;
  if (
    !['identity', 'familyAdd', 'familyCorrection', 'noteCorrection'].every(
      (key) => readbacks[key] === true,
    )
  )
    throw new Basic5CiHold('durable_readbacks_incomplete');
  const counts = evidence.counts;
  const providers = counts.providerRequests as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(counts.readinessAttempts) ||
    Number(counts.readinessAttempts) < 1 ||
    Number(counts.readinessAttempts) > 451 ||
    counts.pageNavigations !== 6 ||
    counts.authenticatedPageNavigations !== counts.pageNavigations ||
    !Number.isSafeInteger(counts.browserHttpRequests) ||
    Number(counts.browserHttpRequests) < 1 ||
    Number(counts.browserHttpRequests) > 320 ||
    !Number.isSafeInteger(counts.browserControlHttpRequests) ||
    Number(counts.browserControlHttpRequests) < 1 ||
    Number(counts.browserControlHttpRequests) > 64 ||
    !Number.isSafeInteger(counts.browserPresentationHttpRequests) ||
    Number(counts.browserPresentationHttpRequests) < 0 ||
    Number(counts.browserPresentationHttpRequests) > 256 ||
    counts.browserHttpRequests !==
      Number(counts.browserControlHttpRequests) + Number(counts.browserPresentationHttpRequests) ||
    counts.browserPageHttpRequests !== Number(counts.browserHttpRequests) - 1 ||
    counts.anonymousPageProbeRequests !== 1 ||
    counts.pageApiMutationRequests !== 4 ||
    counts.applyPosts !== 4 ||
    counts.ownerEditorPostCount !== 4 ||
    counts.ownerApplyRequests !== 4 ||
    !Number.isSafeInteger(counts.recoveryGets) ||
    Number(counts.recoveryGets) < 0 ||
    Number(counts.recoveryGets) > 64 ||
    counts.recoveryRequests !== 0 ||
    counts.embeddingRequests !== 3 ||
    counts.fixtureModelCalls !== 3 ||
    counts.foreignModelCalls !== 0 ||
    providers?.localEmbeddingHttpRequests !== 3 ||
    providers.fixtureModelCallRows !== 3 ||
    providers.nonFixtureModelCallRows !== 0
  )
    throw new Basic5CiHold('acceptance_counters_out_of_bounds');
  const cleanup = evidence.cleanup;
  if (
    ![
      'browserClosed',
      'standaloneProcessGroupExited',
      'embeddingServerClosed',
      'databasePoolClosed',
      'temporaryHomeRemoved',
    ].every((key) => cleanup[key] === true)
  )
    throw new Basic5CiHold('fixture_cleanup_receipt_incomplete');
}

function contentFreeReceipt(record: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'schemaVersion',
    'acceptanceContract',
    'claimScope',
    'scope',
    'result',
    'sourceCommit',
    'sourceWebTree',
    'nodeVersion',
    'imageOS',
    'imageVersion',
    'chromeVersion',
    'chromeVersionDiagnostic',
    'postgresServerVersionNum',
    'utilityChildDiagnostics',
    'workflowContext',
    'requiredArtifactIdentity',
    'diagnosticTraceCompleteness',
    'buildExecutionAttribution',
    'provenanceLimitations',
    'testCount',
    'passCount',
    'skipCount',
    'failCount',
    'executionEnvironment',
    'receipts',
    'durableReadbacks',
    'counts',
    'quiescence',
    'cleanupComplete',
    'targetRetained',
    'targetStatus',
    'controllerScratchStatus',
    'operationSettled',
    'quiescenceStatus',
    'errorCode',
    'standaloneBuildDiagnostic',
    'preparationDiagnostic',
    'utilityChildDiagnostic',
    'caseEntryDiagnostic',
    'vitestDiagnostic',
    'elapsedSeconds',
  ]);
  const clean = Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)));
  if (clean.acceptanceContract !== ACCEPTANCE_CONTRACT)
    throw new Basic5CiHold('acceptance_contract_label_missing');
  clean.claimScope = CLAIM_SCOPE;
  if (Array.isArray(clean.provenanceLimitations))
    clean.provenanceLimitations = [
      ...clean.provenanceLimitations.filter((item) => item !== RECEIPT_PROVENANCE_LIMITATION),
      RECEIPT_PROVENANCE_LIMITATION,
    ];
  if ('workflowContext' in clean)
    clean.workflowContext = contentFreeWorkflowContext(clean.workflowContext);
  if ('requiredArtifactIdentity' in clean)
    clean.requiredArtifactIdentity = contentFreeRequiredArtifactIdentity(
      clean.requiredArtifactIdentity,
    );
  if ('diagnosticTraceCompleteness' in clean)
    clean.diagnosticTraceCompleteness = contentFreeTraceDiagnostic(
      clean.diagnosticTraceCompleteness,
    );
  if ('chromeVersionDiagnostic' in clean)
    clean.chromeVersionDiagnostic = contentFreeChromeVersionDiagnostic(
      clean.chromeVersionDiagnostic,
    );
  if ('preparationDiagnostic' in clean)
    clean.preparationDiagnostic = contentFreePreparationDiagnostic(clean.preparationDiagnostic);
  if ('utilityChildDiagnostic' in clean)
    clean.utilityChildDiagnostic = contentFreeUtilityChildDiagnostics([
      clean.utilityChildDiagnostic,
    ])[0];
  if ('utilityChildDiagnostics' in clean)
    clean.utilityChildDiagnostics = contentFreeUtilityChildDiagnostics(
      clean.utilityChildDiagnostics,
    );
  if ('caseEntryDiagnostic' in clean)
    clean.caseEntryDiagnostic = contentFreeCaseEntryDiagnostic(clean.caseEntryDiagnostic);
  if ('vitestDiagnostic' in clean)
    clean.vitestDiagnostic = contentFreeBasic5CiVitestDiagnostic(clean.vitestDiagnostic);
  if ('standaloneBuildDiagnostic' in clean)
    clean.standaloneBuildDiagnostic = contentFreeBuildDiagnostic(clean.standaloneBuildDiagnostic);
  const encoded = JSON.stringify(clean);
  if (Buffer.byteLength(encoded) > CAPTURE_BYTES)
    throw new Basic5CiHold('content_free_receipt_too_large');
  return clean;
}

export async function runBasic5CiAcceptance(
  ops: Basic5CiOps,
  timers: Basic5CiDeadlineTimers = { schedule: setTimeout, cancel: clearTimeout },
): Promise<Record<string, unknown>> {
  const started = ops.now();
  const deadline = started + OUTER_SECONDS * 1000;
  const receipt: Record<string, unknown> = {
    schemaVersion: 5,
    acceptanceContract: ACCEPTANCE_CONTRACT,
    claimScope: CLAIM_SCOPE,
    scope: 'one BASIC5 CI browser acceptance case',
    result: 'hold',
    cleanupComplete: false,
    targetRetained: false,
    targetStatus: 'not_allocated',
    controllerScratchStatus: 'unknown',
    errorCode: null,
  };
  let preflight: Basic5CiPreflight | undefined;
  let target: Basic5CiTarget | undefined;
  let prepareAttempted = false;
  let caseStarted = false;
  let quiescenceAttempted = false;
  let qualifiedPass = false;
  let phaseOperationUnsettled = false;
  try {
    preflight = await runBeforeDeadline(
      ops,
      started + 20_000,
      'preflight',
      (signal) => ops.preflight(started + 20_000, signal),
      timers,
    );
    assertWithin(ops, started + 20_000, 'preflight');
    receipt.controllerScratchStatus = 'retained';
    Object.assign(receipt, preflight);
    receipt.targetStatus = 'unknown';
    receipt.targetRetained = null;
    const prepareDeadline = Math.min(started + PREPARE_END_SECONDS * 1000, deadline - 110_000);
    prepareAttempted = true;
    target = await runBeforeDeadline(
      ops,
      prepareDeadline,
      'prepare',
      (signal) => ops.prepareFreshTarget(prepareDeadline, signal),
      timers,
    );
    receipt.targetStatus = 'retained';
    receipt.targetRetained = true;
    assertWithin(ops, started + PREPARE_END_SECONDS * 1000, 'prepare');
    if (preflight) Object.assign(receipt, preflight);
    if (ops.now() > started + TEST_START_SECONDS * 1000)
      throw new Basic5CiHold('test_start_ceiling');
    const preparedTarget = target;
    if (!preparedTarget) throw new Basic5CiHold('prepared_target_missing');
    caseStarted = true;
    const testDeadline = Math.min(started + TEST_END_SECONDS * 1000, deadline - 110_000);
    const result = await runBeforeDeadline(
      ops,
      testDeadline,
      'test',
      (signal) => ops.runExactCase(preparedTarget, testDeadline, signal),
      timers,
    );
    validateCiEvidence(result, preparedTarget, preflight);
    Object.assign(receipt, {
      testCount: result.total,
      passCount: result.passed,
      skipCount: result.skipped,
      failCount: result.failed,
      receipts: result.evidence.receipts.map(
        ({
          command,
          operationId,
          requestHash,
          statusVersion,
          outcome,
          uiSavedAfterCleanBaseline,
          ids,
        }) => ({
          command,
          operationId,
          requestHash,
          statusVersion,
          outcome,
          uiSavedAfterCleanBaseline,
          ids: ids
            ? Object.fromEntries(Object.entries(ids).filter(([key]) => RECEIPT_ID_FIELDS.has(key)))
            : null,
        }),
      ),
      durableReadbacks: Object.fromEntries(
        ['identity', 'familyAdd', 'familyCorrection', 'noteCorrection'].map((key) => [
          key,
          result.evidence.durableReadbacks[key],
        ]),
      ),
      counts: Object.fromEntries([
        ...[
          'readinessAttempts',
          'pageNavigations',
          'authenticatedPageNavigations',
          'browserHttpRequests',
          'browserControlHttpRequests',
          'browserPresentationHttpRequests',
          'browserPageHttpRequests',
          'anonymousPageProbeRequests',
          'pageApiMutationRequests',
          'applyPosts',
          'ownerEditorPostCount',
          'ownerApplyRequests',
          'recoveryGets',
          'recoveryRequests',
          'embeddingRequests',
          'fixtureModelCalls',
          'foreignModelCalls',
        ].map((key) => [key, result.evidence.counts[key]]),
        [
          'providerRequests',
          Object.fromEntries(
            ['localEmbeddingHttpRequests', 'fixtureModelCallRows', 'nonFixtureModelCallRows'].map(
              (key) => [
                key,
                (result.evidence.counts.providerRequests as Record<string, unknown>)[key],
              ],
            ),
          ),
        ],
      ]),
      executionEnvironment: Object.fromEntries(
        [
          'platform',
          'nodeVersion',
          'browserChannel',
          'browserVersion',
          'postgresServerVersionNum',
        ].map((key) => [
          key,
          result.evidence.executionEnvironment[
            key as keyof Basic5CiEvidence['executionEnvironment']
          ],
        ]),
      ),
    });
    assertWithin(ops, started + TEST_END_SECONDS * 1000, 'test');
    quiescenceAttempted = true;
    const teardownDeadline = Math.min(started + CLEANUP_END_SECONDS * 1000, deadline - 20_000);
    const quiescence = await runBeforeDeadline(
      ops,
      teardownDeadline,
      'quiescence',
      (signal) => ops.quiesceApplication(teardownDeadline, signal),
      timers,
    );
    assertWithin(ops, teardownDeadline, 'quiescence');
    receipt.quiescence = contentFreeQuiescence(quiescence);
    if (
      !quiescence.known ||
      !quiescence.fixtureRegistryValid ||
      quiescence.liveOwnedProcesses !== 0 ||
      quiescence.liveOwnedListeners !== 0 ||
      quiescence.unknownProcesses !== 0 ||
      [...quiescence.registeredRoles].sort().join(',') !== 'browser,embedding,fixture-worker,web'
    )
      throw new Basic5CiHold('owned_application_quiescence_unknown');
    qualifiedPass = true;
  } catch (error) {
    receipt.errorCode = error instanceof Basic5CiHold ? error.code : 'ci_acceptance_failure';
    if (error instanceof Basic5CiHold && error.chromeVersionDiagnostic)
      receipt.chromeVersionDiagnostic = error.chromeVersionDiagnostic;
    if (error instanceof Basic5CiHold && error.preparationDiagnostic)
      receipt.preparationDiagnostic = error.preparationDiagnostic;
    if (error instanceof Basic5CiHold && error.utilityChildDiagnostic)
      receipt.utilityChildDiagnostic = error.utilityChildDiagnostic;
    if (error instanceof Basic5CiHold && error.caseEntryDiagnostic)
      receipt.caseEntryDiagnostic = error.caseEntryDiagnostic;
    if (error instanceof Basic5CiHold && error.vitestDiagnostic)
      receipt.vitestDiagnostic = error.vitestDiagnostic;
    if (
      caseStarted &&
      error instanceof Basic5CiHold &&
      !error.caseEntryDiagnostic &&
      (error.code === 'test_deadline' || !error.operationSettled)
    ) {
      const stage = ops.currentCaseEntryStage?.();
      if (stage)
        receipt.caseEntryDiagnostic = {
          stage,
          category: 'phase_deadline_or_unsettled',
        } satisfies Basic5CiCaseEntryDiagnostic;
    }
    if (
      prepareAttempted &&
      !caseStarted &&
      error instanceof Basic5CiHold &&
      !error.preparationDiagnostic &&
      (error.code === 'prepare_deadline' || !error.operationSettled)
    ) {
      const stage = ops.currentPreparationStage?.();
      if (stage)
        receipt.preparationDiagnostic = {
          stage,
          category: 'phase_deadline_or_unsettled',
        } satisfies Basic5CiPreparationDiagnostic;
    }
    if (error instanceof Basic5CiHold && error.buildDiagnostic)
      receipt.standaloneBuildDiagnostic = error.buildDiagnostic;
    if (error instanceof Basic5CiHold && !error.operationSettled) {
      phaseOperationUnsettled = true;
      receipt.operationSettled = false;
      receipt.quiescenceStatus = 'not_attempted_pending_phase_operation';
    }
  } finally {
    if (!phaseOperationUnsettled && (caseStarted || prepareAttempted) && !quiescenceAttempted) {
      quiescenceAttempted = true;
      try {
        const teardownDeadline = Math.min(started + CLEANUP_END_SECONDS * 1000, deadline - 20_000);
        const quiescence = await runBeforeDeadline(
          ops,
          teardownDeadline,
          'quiescence',
          (signal) => ops.quiesceApplication(teardownDeadline, signal),
          timers,
        );
        receipt.quiescence = contentFreeQuiescence(quiescence);
      } catch (error) {
        receipt.errorCode = receipt.errorCode ?? 'owned_application_quiescence_failed';
        if (error instanceof Basic5CiHold && !error.operationSettled) {
          phaseOperationUnsettled = true;
          receipt.operationSettled = false;
          receipt.quiescenceStatus = 'pending_phase_operation';
        }
      }
    }
    const cleanupTarget = target;
    if (!phaseOperationUnsettled && cleanupTarget && qualifiedPass) {
      receipt.targetStatus = 'unknown';
      receipt.targetRetained = null;
      try {
        const cleanupDeadline = Math.min(started + CLEANUP_END_SECONDS * 1000, deadline - 20_000);
        await runBeforeDeadline(
          ops,
          cleanupDeadline,
          'target_cleanup',
          (signal) => ops.cleanupExactTarget(cleanupTarget, cleanupDeadline, signal),
          timers,
        );
        assertWithin(ops, cleanupDeadline, 'target_cleanup');
        const absent = await runBeforeDeadline(
          ops,
          cleanupDeadline,
          'target_absence',
          (signal) => ops.verifyTargetAbsent(cleanupTarget, cleanupDeadline, signal),
          timers,
        );
        assertWithin(ops, cleanupDeadline, 'target_absence');
        if (absent) {
          receipt.cleanupComplete = true;
          receipt.targetStatus = 'removed';
          receipt.targetRetained = false;
          receipt.result = 'passed';
        } else {
          receipt.errorCode = 'target_absence_not_proven';
        }
      } catch (error) {
        receipt.errorCode =
          error instanceof Basic5CiHold ? error.code : 'target_cleanup_unverified';
        if (error instanceof Basic5CiHold && !error.operationSettled) {
          phaseOperationUnsettled = true;
          receipt.operationSettled = false;
        }
      }
    }
    receipt.elapsedSeconds = Math.max(0, (ops.now() - started) / 1000);
    try {
      await runBeforeDeadline(
        ops,
        deadline,
        'receipt_write',
        (signal) => ops.writeContentFreeReceipt(contentFreeReceipt(receipt), signal),
        timers,
        0,
      );
    } catch (error) {
      receipt.result = 'hold';
      receipt.errorCode = 'content_free_receipt_write_failed';
      if (error instanceof Basic5CiHold && !error.operationSettled) {
        phaseOperationUnsettled = true;
        receipt.operationSettled = false;
        receipt.quiescenceStatus =
          receipt.quiescenceStatus ?? 'not_attempted_receipt_write_pending';
      }
    }
  }
  return contentFreeReceipt(receipt);
}

// Real CI adapter follows below. It imports application and fixture modules only
// after constructing the private synthetic environment in preflight().
export class RealBasic5CiOps implements Basic5CiOps {
  private started = performance.now();
  private outerExpired = false;
  private readonly outerTimer: NodeJS.Timeout;
  private repoRoot = '';
  private sourceDatabaseUrl = '';
  private privateRoot = '';
  private home = '';
  private temp = '';
  private registryDirectory = '';
  private registryPath = '';
  private preloaderPath = '';
  private baseEnv: NodeJS.ProcessEnv = {};
  private targetEnv: NodeJS.ProcessEnv = {};
  private targetSupport?: TargetSupport;
  private dbModule?: DbModule;
  private proof?: ProcessProof;
  private provenance?: BuildProvenanceModule;
  private preflightResult?: Basic5CiPreflight;
  private target?: Basic5CiTarget;
  private preparationStage?: Basic5CiPreparationDiagnostic['stage'];
  private caseEntryStage?: Basic5CiCaseEntryDiagnostic['stage'];
  private readonly ownedProcesses = new Map<number, LinuxIdentity>();
  private readonly ownedRoots = new Map<number, LinuxIdentity>();
  private baselineListeners = new Map<string, number>();
  private fixtureRecords: RegistryRecord[] = [];
  private readonly utilityChildTestDriver?: Basic5CiUtilityChildTestDriver;

  constructor(utilityChildTestDriver?: Basic5CiUtilityChildTestDriver) {
    this.utilityChildTestDriver = utilityChildTestDriver;
    if (utilityChildTestDriver) {
      this.repoRoot = utilityChildTestDriver.repositoryRoot ?? '';
      this.started = utilityChildTestDriver.now();
      this.proof = utilityChildTestDriver.proof;
    }
    this.outerTimer = setTimeout(() => {
      this.outerExpired = true;
    }, OUTER_SECONDS * 1000);
  }

  dispose(): void {
    clearTimeout(this.outerTimer);
  }

  readonly now = (): number => {
    return this.utilityChildTestDriver?.now() ?? performance.now();
  };

  runUtilityChild(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    deadline: number,
    label: 'create-target' | 'migrate' | 'seed',
    signal: AbortSignal,
  ) {
    return this.runChild(command, args, env, deadline, label, signal);
  }

  currentPreparationStage(): Basic5CiPreparationDiagnostic['stage'] | undefined {
    return this.preparationStage;
  }

  private runPreparationStep<T>(
    stage: Basic5CiPreparationDiagnostic['stage'],
    failureCode: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.preparationStage = stage;
    return runBasic5CiPreparationStep(stage, failureCode, operation);
  }

  currentCaseEntryStage(): Basic5CiCaseEntryDiagnostic['stage'] | undefined {
    return this.caseEntryStage;
  }

  private runCaseEntryStep<T>(
    stage: Basic5CiCaseEntryDiagnostic['stage'],
    failureCode: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.caseEntryStage = stage;
    return runBasic5CiCaseEntryStep(stage, failureCode, operation);
  }

  private assertDeadline(deadline: number, phase: string): void {
    if (
      this.outerExpired ||
      this.now() >= deadline ||
      this.now() >= this.started + OUTER_SECONDS * 1000
    )
      throw new Basic5CiHold(`${phase}_deadline`);
  }

  private async importHelpers(): Promise<void> {
    this.proof ??= (await import(
      new URL('./basic5-ci-process-proof.js', import.meta.url).href
    )) as unknown as ProcessProof;
    this.provenance ??= (await import(
      new URL('./basic5-ci-build-provenance.js', import.meta.url).href
    )) as unknown as BuildProvenanceModule;
  }

  private async captureSession(
    root: LinuxIdentity,
    deadline: number,
    confirmedSnapshot?: Map<number, LinuxSnapshot>,
  ): Promise<Set<number>> {
    const proof = this.proof;
    if (!proof) throw new Basic5CiHold('linux_process_proof_unavailable');
    const readSnapshot = async (stage: Basic5CiCensusDiagnostic['stage']) => {
      if (this.now() >= deadline || this.outerExpired)
        throw new Basic5CiCensusHold({ stage, reason: 'deadline' });
      try {
        const snapshot = await proof.readBasic5LinuxProcessSnapshot();
        if (this.now() >= deadline || this.outerExpired)
          throw new Basic5CiCensusHold({ stage, reason: 'deadline' });
        return snapshot;
      } catch (error) {
        if (error instanceof Basic5CiCensusHold) throw error;
        throw censusFailure(stage, error);
      }
    };
    const snapshot = confirmedSnapshot ?? (await readSnapshot('snapshot'));
    const confirmAbsence = async (pid: number, expected: LinuxSnapshot): Promise<Set<number>> => {
      if (confirmedSnapshot)
        throw new Basic5CiCensusHold({
          stage: 'absence_confirmation',
          reason: 'convergence_exhausted',
        });
      const fresh = await readSnapshot('absence_confirmation');
      const present = fresh.get(pid);
      if (present)
        throw new Basic5CiCensusHold({
          stage: 'absence_confirmation',
          reason: changedProcessFact(expected, present) ?? 'absence_not_confirmed',
        });
      // Exactly one restart from positive absence. Retain all enrolled identities;
      // a missing unverified parent never becomes ancestry for a new descendant.
      return this.captureSession(root, deadline, fresh);
    };
    const liveSession = new Set(
      [...snapshot.values()].filter((row) => row.sid === root.sid).map((row) => row.pid),
    );
    const alreadyOwned = new Set<number>();
    for (const expected of this.ownedProcesses.values()) {
      if (expected.sid !== root.sid) continue;
      alreadyOwned.add(expected.pid);
      const current = snapshot.get(expected.pid);
      if (current) {
        const reason = changedProcessFact(expected, current);
        if (reason) throw new Basic5CiCensusHold({ stage: 'known_identity_compare', reason });
      }
    }
    let enrollmentOrder: number[];
    if ([...snapshot.values()].some((row) => row.sid === root.sid && row.pgid <= 0))
      throw new Basic5CiCensusHold({
        stage: 'enrollment',
        reason: 'owned_process_identity_ineligible',
      });
    try {
      enrollmentOrder = ownedSessionEnrollmentOrder(snapshot, root.sid, alreadyOwned);
    } catch {
      throw new Basic5CiCensusHold({ stage: 'enrollment', reason: 'ancestry_unproven' });
    }
    for (const pid of enrollmentOrder) {
      const row = snapshot.get(pid);
      if (!row)
        throw new Basic5CiCensusHold({
          stage: 'new_identity_read',
          reason: 'snapshot_row_missing',
        });
      let identity: LinuxIdentity | undefined;
      try {
        identity = await proof.readBasic5LinuxProcessIdentity(pid);
      } catch (error) {
        throw censusFailure('new_identity_read', error);
      }
      if (!identity) return confirmAbsence(pid, row);
      const reason = changedProcessFact(row, identity);
      if (reason) throw new Basic5CiCensusHold({ stage: 'new_identity_compare', reason });
      if (identity.pgid <= 0 || identity.sid <= 0)
        throw new Basic5CiCensusHold({
          stage: 'new_identity_compare',
          reason: 'owned_process_identity_ineligible',
        });
      this.ownedProcesses.set(pid, identity);
    }
    for (const pid of liveSession) {
      const expected = this.ownedProcesses.get(pid);
      if (!expected)
        throw new Basic5CiCensusHold({ stage: 'known_identity_read', reason: 'ancestry_unproven' });
      let current: LinuxIdentity | undefined;
      try {
        current = await proof.readBasic5LinuxProcessIdentity(pid, expected);
      } catch (error) {
        // The helper attests a positive Z-state reread matching this full
        // enrolled tuple. It supplies no replacement identity or signal authority.
        if ((error as { code?: unknown } | null)?.code === 'known_process_terminal') continue;
        throw censusFailure('known_identity_read', error);
      }
      if (!current) return confirmAbsence(pid, expected);
      const reason =
        changedProcessFact(expected, current) ??
        (current.exe !== expected.exe ? 'executable_changed' : undefined);
      if (reason) throw new Basic5CiCensusHold({ stage: 'known_identity_compare', reason });
    }
    return liveSession;
  }

  private async signalExact(
    identity: LinuxIdentity,
    signal: NodeJS.Signals,
    deadline?: number,
  ): Promise<void> {
    if (deadline !== undefined) this.assertDeadline(deadline, 'utility_direct_child_stop');
    let current: LinuxIdentity | undefined;
    try {
      current = await this.proof?.readBasic5LinuxProcessIdentity(identity.pid, identity);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'known_process_terminal') return;
      throw error;
    }
    if (deadline !== undefined) this.assertDeadline(deadline, 'utility_direct_child_stop');
    if (!current) return;
    if (
      current.startTimeTicks !== identity.startTimeTicks ||
      current.ppid !== identity.ppid ||
      current.pgid !== identity.pgid ||
      current.sid !== identity.sid ||
      current.exe !== identity.exe
    )
      throw new Basic5CiHold('refusing_signal_to_changed_process_identity');
    try {
      if (this.utilityChildTestDriver)
        this.utilityChildTestDriver.killProcess(identity.pid, signal);
      else process.kill(identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw new Basic5CiHold('owned_process_signal_failed');
    }
  }

  private async waitForUtilityChildClose(
    closed: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async stopUtilityDirectChild(
    identity: LinuxIdentity,
    closed: Promise<void>,
    deadline: number,
  ): Promise<boolean> {
    const wallDeadline = performance.now() + Math.max(0, Math.min(2_000, deadline - this.now()));
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const waitMs = Math.min(1_000, deadline - this.now(), wallDeadline - performance.now());
      if (waitMs <= 0) return false;
      try {
        await this.signalExact(identity, signal, deadline);
      } catch {
        return false;
      }
      if (await this.waitForUtilityChildClose(closed, waitMs)) return true;
    }
    return false;
  }

  private async assertUtilityOriginalSessionEmpty(
    root: LinuxIdentity,
    proof: ProcessProof,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      this.assertDeadline(deadline, 'final_session_census');
      assertNotAborted(signal, 'final_session_census');
      let snapshot: Map<number, LinuxSnapshot>;
      try {
        snapshot = await proof.readBasic5LinuxProcessSnapshot();
      } catch (error) {
        throw censusFailure('final_snapshot', error);
      }
      this.assertDeadline(deadline, 'final_session_census');
      assertNotAborted(signal, 'final_session_census');
      const rootPid = snapshot.get(root.pid);
      if (rootPid) {
        const identityChange = changedProcessFact(root, rootPid);
        if (identityChange)
          throw new Basic5CiCensusHold(
            { stage: 'final_snapshot', reason: identityChange },
            'utility_root_identity_ambiguous',
          );
      }
      if ([...snapshot.values()].some((row) => row.sid === root.sid))
        throw new Basic5CiCensusHold(
          { stage: 'final_snapshot', reason: 'descendants_still_present' },
          'utility_original_session_not_empty',
        );
    }
  }

  private async stopKnownSessions(deadline: number, signal?: AbortSignal): Promise<void> {
    const sessions = new Map<number, LinuxIdentity>();
    for (const identity of this.ownedRoots.values()) sessions.set(identity.sid, identity);
    const records = this.fixtureRecords;
    for (const record of records) {
      const identity: LinuxIdentity = {
        pid: record.pid,
        ppid: record.ppid,
        pgid: record.pgid,
        sid: record.sid,
        startTimeTicks: record.startTimeTicks,
        exe: record.exe,
      };
      this.ownedProcesses.set(identity.pid, identity);
      sessions.set(identity.sid, identity);
    }
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      const stageEnd = Math.min(deadline, this.now() + 2_000);
      while (this.now() < stageEnd) {
        if (signal?.aborted) throw new Basic5CiHold('quiescence_cancelled');
        let live = false;
        for (const root of sessions.values()) {
          const pids = await this.captureSession(root, deadline);
          for (const pid of pids) {
            if (signal?.aborted) throw new Basic5CiHold('quiescence_cancelled');
            live = true;
            const identity = this.ownedProcesses.get(pid);
            if (!identity) throw new Basic5CiHold('live_process_missing_verified_identity');
            await this.signalExact(identity, sig);
          }
        }
        for (const record of records) {
          if (signal?.aborted) throw new Basic5CiHold('quiescence_cancelled');
          let current: LinuxIdentity | undefined;
          try {
            current = await this.proof?.readBasic5LinuxProcessIdentity(record.pid, record);
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'known_process_terminal') {
              live = true;
              continue;
            }
            throw error;
          }
          if (!current) continue;
          if (
            current.startTimeTicks !== record.startTimeTicks ||
            current.ppid !== record.ppid ||
            current.pgid !== record.pgid ||
            current.sid !== record.sid ||
            current.exe !== record.exe
          )
            throw new Basic5CiHold('registered_process_identity_changed');
          live = true;
          await this.signalExact(current, sig);
        }
        if (!live) return;
        if (this.utilityChildTestDriver) await this.utilityChildTestDriver.sleep(50);
        else await sleep(50);
      }
    }
    for (const root of sessions.values()) {
      if ((await this.captureSession(root, deadline)).size > 0)
        throw new Basic5CiHold('owned_processes_remain_after_bounded_stop', false);
    }
    for (const record of records) {
      if (await this.proof?.readBasic5LinuxProcessIdentity(record.pid))
        throw new Basic5CiHold('registered_process_remains_after_bounded_stop', false);
    }
  }

  private async readListeners(): Promise<Map<string, number>> {
    let tcp: string;
    let tcp6: string;
    try {
      [tcp, tcp6] = await Promise.all([
        readFile('/proc/net/tcp', 'utf8'),
        readFile('/proc/net/tcp6', 'utf8'),
      ]);
    } catch {
      throw new Basic5CiHold('linux_listener_census_unavailable');
    }
    return parseLinuxListenTable(tcp, tcp6);
  }

  private async runReadOnlyMetadata(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    deadline: number,
    label: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
    const chromePath = this.proof?.BASIC5_CI_CHROME_EXECUTABLE;
    const allowed =
      (command === 'git' &&
        [
          ['rev-parse', 'HEAD'],
          ['status', '--porcelain=v1', '--untracked-files=all'],
          ['rev-parse', 'HEAD:apps/web'],
        ].some((known) => JSON.stringify(known) === JSON.stringify(args))) ||
      (typeof chromePath === 'string' &&
        command === chromePath &&
        JSON.stringify(args) === JSON.stringify(['--version']));
    if (!allowed) throw new Basic5CiHold(`${label}_metadata_command_not_allowlisted`);
    this.assertDeadline(deadline, label);
    assertNotAborted(signal, label);
    return runBasic5CiReadOnlyMetadata(
      command,
      args,
      {
        cwd: this.repoRoot,
        env,
        encoding: 'buffer',
        maxBuffer: CAPTURE_BYTES,
        timeout: 5_000,
        killSignal: 'SIGKILL',
        signal,
      },
      deadline,
      this.now,
      this.utilityChildTestDriver?.metadataExec?.bind(this.utilityChildTestDriver),
    );
  }

  private async runChild(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    deadline: number,
    label: string,
    signal: AbortSignal,
  ): Promise<{
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
    observedExitCode?: number | null;
    utilityDiagnostic?: Basic5CiUtilityChildDiagnostic;
  }> {
    this.assertDeadline(deadline, label);
    assertNotAborted(signal, label);
    const utility = utilityForChildLabel(label);
    const proof = this.proof;
    if (!proof) throw new Basic5CiHold('linux_process_proof_unavailable');
    const cwd = label === 'migrate' ? join(this.repoRoot, 'packages/db') : this.repoRoot;
    if (label === 'migrate') {
      try {
        if (realpathSync(cwd) !== cwd || !lstatSync(cwd).isDirectory())
          throw new Basic5CiHold('migration_working_directory_unverified');
      } catch {
        throw new Basic5CiHold('migration_working_directory_unverified');
      }
      this.assertDeadline(deadline, label);
      assertNotAborted(signal, label);
    }
    let child: ReturnType<typeof spawn>;
    try {
      const spawnChild = this.utilityChildTestDriver
        ? this.utilityChildTestDriver.spawn.bind(this.utilityChildTestDriver)
        : spawn;
      child = spawnChild(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const utility = utilityForChildLabel(label);
      if (utility)
        throw new Basic5CiHold(
          `${label}_spawn_failed`,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          makeUtilityChildDiagnostic(utility, 'spawn', 'spawn_error', null, false, 0, 0, error),
        );
      throw error;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;
    let closed = false;
    let exitCode = 1;
    let childError = false;
    let childErrorCode: unknown;
    let identityReadErrorCode: string | undefined;
    let closeSignal: NodeJS.Signals | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const closedPromise = new Promise<void>((resolveClose) => {
      child.once('close', (code, childSignal) => {
        exitCode = code ?? (childSignal ? 1 : 1);
        closeSignal = childSignal;
        closed = true;
        resolveClose();
      });
    });
    child.once('error', (error) => {
      childError = true;
      childErrorCode =
        error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      stdoutBytes += chunk.length;
      if (outputBytes <= CAPTURE_BYTES) stdout.push(Buffer.from(chunk));
      else overflow = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      stderrBytes += chunk.length;
      if (outputBytes <= CAPTURE_BYTES) stderr.push(Buffer.from(chunk));
      else overflow = true;
    });
    let directAbortSettlement: Promise<boolean> | undefined;
    const abortDirectChild = () => {
      if (!utility) directAbortSettlement = settleDirectChildHandle(child, closedPromise);
    };
    signal.addEventListener('abort', abortDirectChild, { once: true });
    let root: LinuxIdentity;
    try {
      root = await verifyDirectChildBootstrap(
        child,
        process.pid,
        async (childPid) => {
          try {
            return await proof.readBasic5LinuxProcessIdentity(childPid);
          } catch (error) {
            const code =
              error && typeof error === 'object'
                ? (error as NodeJS.ErrnoException).code
                : undefined;
            if (typeof code === 'string') identityReadErrorCode = code;
            throw error;
          }
        },
        closedPromise,
        !utility,
      );
    } catch (error) {
      if (utility)
        throw holdForBasic5CiUtilityBootstrapFailure(utility, error, {
          exitCode: closed ? exitCode : null,
          closed,
          stdoutBytes,
          stderrBytes,
          signal: closeSignal,
          errnoCode: typeof childErrorCode === 'string' ? childErrorCode : identityReadErrorCode,
          launchAbsent: child.pid === undefined,
        });
      throw error;
    } finally {
      signal.removeEventListener('abort', abortDirectChild);
      if (directAbortSettlement) await directAbortSettlement;
    }
    if (utility) {
      const failUtility = async (
        code: string,
        status: Basic5CiUtilityChildDiagnostic['status'],
        error?: unknown,
      ): Promise<never> => {
        const cleanupDeadline = Math.min(
          this.started + CLEANUP_END_SECONDS * 1000,
          this.started + OUTER_SECONDS * 1000,
          this.now() + 2_000,
        );
        if (!closed) await this.stopUtilityDirectChild(root, closedPromise, cleanupDeadline);
        const diagnostic = makeUtilityChildDiagnostic(
          utility,
          'completed',
          status,
          closed ? exitCode : null,
          closed,
          stdoutBytes,
          stderrBytes,
          error,
          closeSignal,
        );
        throw new Basic5CiHold(code, false, undefined, undefined, undefined, undefined, diagnostic);
      };

      if (signal.aborted) return failUtility(`${label}_cancelled`, 'deadline');
      while (!closed) {
        if (signal.aborted) return failUtility(`${label}_cancelled`, 'deadline');
        if (overflow) return failUtility(`${label}_capture_limit`, 'capture_limit');
        if (this.now() >= deadline || this.now() >= this.started + OUTER_SECONDS * 1000)
          return failUtility(`${label}_deadline`, 'deadline');
        if (childError) return failUtility(`${label}_child_error`, 'completed', childErrorCode);
        if (this.utilityChildTestDriver) await this.utilityChildTestDriver.sleep(50);
        else await sleep(50);
      }

      if (signal.aborted) return failUtility(`${label}_cancelled`, 'deadline');
      if (overflow) return failUtility(`${label}_capture_limit`, 'capture_limit');
      if (this.now() >= deadline || this.now() >= this.started + OUTER_SECONDS * 1000)
        return failUtility(`${label}_deadline`, 'deadline');
      if (childError) return failUtility(`${label}_child_error`, 'completed', childErrorCode);

      try {
        await this.assertUtilityOriginalSessionEmpty(root, proof, deadline, signal);
      } catch (error) {
        const hold = error instanceof Basic5CiHold ? error : undefined;
        const diagnostic = makeUtilityChildDiagnostic(
          utility,
          'final_session_census',
          'session_census_unverified',
          exitCode,
          true,
          stdoutBytes,
          stderrBytes,
          error,
          closeSignal,
        );
        throw new Basic5CiHold(
          hold?.code ?? `${label}_final_census_failed`,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          diagnostic,
        );
      }

      if (exitCode !== 0) return failUtility(`${label}_nonzero_exit`, 'completed');
      if (outputBytes > CAPTURE_BYTES)
        return failUtility(`${label}_capture_limit`, 'capture_limit');
      return {
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        utilityDiagnostic: makeUtilityChildDiagnostic(
          utility,
          'completed',
          'completed',
          exitCode,
          true,
          stdoutBytes,
          stderrBytes,
          undefined,
          closeSignal,
          'direct_child_closed_and_original_session_empty',
        ),
      };
    }
    this.ownedRoots.set(root.pid, root);
    this.ownedProcesses.set(root.pid, root);
    if (signal.aborted) {
      await this.stopKnownSessions(
        Math.min(this.started + CLEANUP_END_SECONDS * 1000, this.now() + 4_100),
      );
      const utility = utilityForChildLabel(label);
      throw new Basic5CiHold(
        `${label}_cancelled`,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        utility
          ? makeUtilityChildDiagnostic(
              utility,
              'owned_session_census',
              'deadline',
              null,
              closed,
              stdoutBytes,
              stderrBytes,
            )
          : undefined,
      );
    }
    while (!closed) {
      if (signal.aborted) {
        await this.stopKnownSessions(
          Math.min(this.started + CLEANUP_END_SECONDS * 1000, this.now() + 4_100),
        );
        const utility = utilityForChildLabel(label);
        throw new Basic5CiHold(
          `${label}_cancelled`,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          utility
            ? makeUtilityChildDiagnostic(
                utility,
                'owned_session_census',
                'deadline',
                null,
                closed,
                stdoutBytes,
                stderrBytes,
              )
            : undefined,
        );
      }
      if (overflow || this.now() >= deadline || this.now() >= this.started + OUTER_SECONDS * 1000) {
        await this.stopKnownSessions(
          Math.min(this.started + CLEANUP_END_SECONDS * 1000, this.now() + 4_100),
        );
        const utility = utilityForChildLabel(label);
        throw new Basic5CiHold(
          overflow ? `${label}_capture_limit` : `${label}_deadline`,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          utility
            ? makeUtilityChildDiagnostic(
                utility,
                'owned_session_census',
                overflow ? 'capture_limit' : 'deadline',
                null,
                closed,
                stdoutBytes,
                stderrBytes,
              )
            : undefined,
          label === 'basic5-vitest' && overflow
            ? basic5CiVitestCaptureLimit(
                closed && !closeSignal ? exitCode : null,
                stdoutBytes,
                stderrBytes,
              )
            : undefined,
        );
      }
      try {
        await this.captureSession(root, deadline);
      } catch (error) {
        const utility = utilityForChildLabel(label);
        if (utility)
          throw new Basic5CiHold(
            `${label}_session_census_failed`,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            makeUtilityChildDiagnostic(
              utility,
              'owned_session_census',
              'session_census_unverified',
              null,
              closed,
              stdoutBytes,
              stderrBytes,
              error,
              closeSignal,
            ),
          );
        throw error;
      }
      if (this.utilityChildTestDriver) await this.utilityChildTestDriver.sleep(50);
      else await sleep(50);
    }
    if (childError)
      throw new Basic5CiHold(
        `${label}_child_error`,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        utility
          ? makeUtilityChildDiagnostic(
              utility,
              'completed',
              'completed',
              exitCode,
              closed,
              stdoutBytes,
              stderrBytes,
              childErrorCode,
              closeSignal,
            )
          : undefined,
      );
    if (signal.aborted)
      throw new Basic5CiHold(
        `${label}_cancelled`,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        utility
          ? makeUtilityChildDiagnostic(
              utility,
              'final_session_census',
              'deadline',
              exitCode,
              closed,
              stdoutBytes,
              stderrBytes,
              childErrorCode,
              closeSignal,
            )
          : undefined,
      );
    try {
      await this.captureSession(root, deadline);
      let liveRootSession: Map<number, LinuxSnapshot>;
      try {
        liveRootSession = await proof.readBasic5LinuxProcessSnapshot();
      } catch (error) {
        throw censusFailure('final_snapshot', error);
      }
      if ([...liveRootSession.values()].some((row) => row.sid === root.sid)) {
        await this.stopKnownSessions(
          Math.min(this.started + CLEANUP_END_SECONDS * 1000, this.now() + 4_100),
        );
        throw new Basic5CiCensusHold(
          {
            stage: 'final_snapshot',
            reason: 'descendants_still_present',
          },
          `${label}_descendant_not_closed`,
        );
      }
    } catch (error) {
      const utility = utilityForChildLabel(label);
      if (utility)
        throw new Basic5CiHold(
          error instanceof Basic5CiHold ? error.code : `${label}_final_census_failed`,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          makeUtilityChildDiagnostic(
            utility,
            'final_session_census',
            'session_census_unverified',
            exitCode,
            closed,
            stdoutBytes,
            stderrBytes,
            error,
            closeSignal,
          ),
        );
      throw error;
    }
    if (outputBytes > CAPTURE_BYTES)
      throw new Basic5CiHold(
        `${label}_capture_limit`,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        utility
          ? makeUtilityChildDiagnostic(
              utility,
              'completed',
              'capture_limit',
              exitCode,
              closed,
              stdoutBytes,
              stderrBytes,
              childErrorCode,
              closeSignal,
            )
          : undefined,
        label === 'basic5-vitest'
          ? basic5CiVitestCaptureLimit(
              closed && !closeSignal ? exitCode : null,
              stdoutBytes,
              stderrBytes,
            )
          : undefined,
      );
    return {
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      ...(label === 'basic5-vitest' ? { observedExitCode: closeSignal ? null : exitCode } : {}),
      ...(utility
        ? {
            utilityDiagnostic: makeUtilityChildDiagnostic(
              utility,
              'completed',
              'completed',
              exitCode,
              closed,
              stdoutBytes,
              stderrBytes,
              childErrorCode,
              closeSignal,
            ),
          }
        : {}),
    };
  }

  async preflight(deadline: number, signal: AbortSignal): Promise<Basic5CiPreflight> {
    this.assertDeadline(deadline, 'preflight');
    assertNotAborted(signal, 'preflight');
    const ambient = { ...process.env };
    assertBasic5CiWorkflowAdmission(ambient);
    if (process.platform !== 'linux' || !/^v?26\./.test(process.version))
      throw new Basic5CiHold('requires_linux_node_26');
    const sourceUrl = ambient.ASSISTANT_BASIC5_CI_DATABASE_URL ?? ambient.DATABASE_URL;
    const workspace = ambient.GITHUB_WORKSPACE ?? process.cwd();
    const runnerOs = ambient.RUNNER_OS;
    const imageOS = ambient.ImageOS;
    const imageVersion = ambient.ImageVersion;
    const expectedCommit = ambient.GITHUB_SHA;
    if (
      !sourceUrl ||
      !workspace ||
      runnerOs !== 'Linux' ||
      !imageOS ||
      !imageVersion ||
      !expectedCommit ||
      !/^[a-f0-9]{40}$/i.test(expectedCommit)
    )
      throw new Basic5CiHold('allowlisted_ci_observations_missing');
    if (!/^postgres(?:ql)?:\/\//i.test(sourceUrl))
      throw new Basic5CiHold('postgres_service_url_missing');
    this.sourceDatabaseUrl = sourceUrl;
    this.repoRoot = resolve(workspace);
    this.privateRoot = await mkdtemp(join(tmpdir(), 'basic5-ci-'));
    this.home = join(this.privateRoot, 'home');
    this.temp = join(this.privateRoot, 'tmp');
    this.registryDirectory = join(this.privateRoot, 'registry');
    this.registryPath = join(this.registryDirectory, 'processes.ndjson');
    await Promise.all([
      mkdir(this.home, { mode: 0o700 }),
      mkdir(this.temp, { mode: 0o700 }),
      mkdir(this.registryDirectory, { mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(this.privateRoot, 0o700),
      chmod(this.home, 0o700),
      chmod(this.temp, 0o700),
      chmod(this.registryDirectory, 0o700),
    ]);
    this.preloaderPath = join(this.repoRoot, 'scripts/deny-test-egress.mjs');
    this.baseEnv = {
      PATH: ambient.PATH ?? '/usr/bin:/bin',
      HOME: this.home,
      TMPDIR: this.temp,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: 'true',
      RUNNER_OS: 'Linux',
      NODE_ENV: 'test',
      ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
      NODE_OPTIONS: `--import=${this.preloaderPath}`,
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      GOOGLE_CLOUD_KEYFILE_JSON: '',
      GCLOUD_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
      AUTH_GOOGLE_SECRET: '',
      GOOGLE_OAUTH_CLIENT_SECRET: '',
      BOT_GOOGLE_REFRESH_TOKEN: '',
      GITHUB_TOKEN: '',
      TWILIO_AUTH_TOKEN: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AZURE_CLIENT_SECRET: '',
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, this.baseEnv);
    await this.importHelpers();
    assertNotAborted(signal, 'preflight');

    const head = await this.runReadOnlyMetadata(
      'git',
      ['rev-parse', 'HEAD'],
      this.baseEnv,
      deadline,
      'source-head',
      signal,
    );
    const status = await this.runReadOnlyMetadata(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      this.baseEnv,
      deadline,
      'source-status',
      signal,
    );
    const webTree = await this.runReadOnlyMetadata(
      'git',
      ['rev-parse', 'HEAD:apps/web'],
      this.baseEnv,
      deadline,
      'web-tree',
      signal,
    );
    const sourceCommit = head.stdout.toString('utf8').trim();
    const sourceWebTree = webTree.stdout.toString('utf8').trim();
    if (
      head.exitCode !== 0 ||
      status.exitCode !== 0 ||
      webTree.exitCode !== 0 ||
      head.stderr.length ||
      status.stderr.length ||
      webTree.stderr.length ||
      sourceCommit !== expectedCommit ||
      status.stdout.length !== 0 ||
      !/^[a-f0-9]{40}$/i.test(sourceWebTree)
    )
      throw new Basic5CiHold('ci_source_checkout_not_exact_clean');
    const artifactRoot = join(this.repoRoot, 'apps/web/.next/standalone');
    const serverRoot = join(artifactRoot, 'apps/web');
    const provenanceModule = this.provenance;
    if (!provenanceModule) throw new Basic5CiHold('build_provenance_helper_unavailable');
    const provenance = await provenanceModule.observeBasic5CiBuildProvenance({
      repositoryRoot: this.repoRoot,
      artifactRoot,
      serverRoot,
      sourceCommit,
      sourceWebTree,
      nodeVersion: process.version,
      imageOS,
      imageVersion,
      collectTraceDiagnostic: false,
    });
    assertNotAborted(signal, 'preflight');
    const diagnostic = buildProvenanceDiagnostic(provenance, {
      sourceCommit,
      sourceWebTree,
      nodeVersion: process.version,
      imageOS,
      imageVersion,
    });
    if (Object.values(diagnostic.checks).some((check) => !check))
      throw new Basic5CiHold('required_runtime_artifact_identity_incomplete', true, diagnostic);
    const proof = this.proof;
    if (!proof) throw new Basic5CiHold('linux_process_proof_unavailable');
    let chrome: { exitCode: number; stdout: Buffer; stderr: Buffer };
    try {
      chrome = await this.runReadOnlyMetadata(
        proof.BASIC5_CI_CHROME_EXECUTABLE,
        ['--version'],
        this.baseEnv,
        deadline,
        'chrome-version',
        signal,
      );
    } catch (error) {
      const status =
        error instanceof Basic5CiHold && error.code.includes('capture_limit')
          ? 'capture_limit'
          : 'spawn_or_timeout';
      throw new Basic5CiHold(
        error instanceof Basic5CiHold ? error.code : 'allowlisted_chrome_version_unavailable',
        error instanceof Basic5CiHold ? error.operationSettled : true,
        error instanceof Basic5CiHold ? error.buildDiagnostic : undefined,
        chromeVersionFailureDiagnostic(status),
      );
    }
    const chromeObservation = observeBasic5CiChromeVersion(chrome);
    const chromeVersion = chromeObservation.version;
    if (!chromeVersion) {
      const status = chromeObservation.diagnostic.status;
      throw new Basic5CiHold(
        status === 'nonzero_exit'
          ? 'allowlisted_chrome_version_nonzero_exit'
          : status === 'capture_limit'
            ? 'allowlisted_chrome_version_capture_limit'
            : 'allowlisted_chrome_version_malformed',
        true,
        undefined,
        chromeObservation.diagnostic,
      );
    }
    this.baselineListeners = await this.readListeners();
    assertNotAborted(signal, 'preflight');
    this.preflightResult = {
      sourceCommit,
      sourceWebTree,
      nodeVersion: process.version,
      imageOS,
      imageVersion,
      chromeVersion,
      chromeVersionDiagnostic: chromeObservation.diagnostic,
      postgresServerVersionNum: null,
      utilityChildDiagnostics: [],
      workflowContext: {
        event: 'push',
        ref: 'refs/heads/main',
        runAttempt: 1,
        frozenLockfileInstallAndBuildSucceeded: true,
        frozenLockfileBuildBasis: 'ordered_ci_steps_completed_before_acceptance',
        workflowSha: ambient.GITHUB_WORKFLOW_SHA as string,
        lockfileSha256: createHash('sha256')
          .update(await readFile(join(this.repoRoot, 'pnpm-lock.yaml')))
          .digest('hex'),
      },
      requiredArtifactIdentity: provenance.requiredArtifactIdentity,
      diagnosticTraceCompleteness: provenance.diagnosticTraceCompleteness,
      buildExecutionAttribution: provenance.buildExecutionAttribution,
      provenanceLimitations: [...provenance.limitations],
    };
    return this.preflightResult;
  }

  async prepareFreshTarget(deadline: number, signal: AbortSignal): Promise<Basic5CiTarget> {
    this.assertDeadline(deadline, 'prepare');
    assertNotAborted(signal, 'prepare');
    const support = await this.runPreparationStep(
      'test_target_module_import',
      'fresh_target_support_unavailable',
      async () =>
        (await import(
          new URL('./test-target.js', import.meta.url).href
        )) as unknown as TargetSupport,
    );
    assertNotAborted(signal, 'prepare');
    this.targetSupport = support;
    const allocation = await this.runPreparationStep(
      'target_allocation',
      'fresh_target_allocation_failed',
      () => {
        const token = randomBytes(12).toString('hex');
        return support.allocateTestTarget(this.sourceDatabaseUrl, token, 'standard');
      },
    );
    const target = allocation;
    this.target = target;
    this.targetEnv = await this.runPreparationStep(
      'target_environment',
      'fresh_target_environment_failed',
      () => ({
        ...this.baseEnv,
        DATABASE_URL: target.databaseUrl,
        TEST_DATABASE_URL: target.databaseUrl,
        ASSISTANT_TEST_TARGET_TOKEN: target.token,
        ASSISTANT_TEST_TARGET_KIND: 'standard',
        OWNER_EMAIL: 'basic5-owner@example.test',
        ASSISTANT_EMAIL: 'basic5-owner@example.test',
        OWNER_NAME: 'BASIC5 Synthetic Owner',
        ASSISTANT_NAME: 'BASIC5 Synthetic Owner',
        OWNER_PHONE: '',
        PERSISTENCE_DRIVER: 'postgres',
        LLM_PROVIDER: 'vertex',
        OPENROUTER_API_KEY: '',
        ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
        POSTGRES_SOURCE_WRITES_FENCED: 'false',
      }),
    );
    const testDb = join(this.repoRoot, 'packages/db/src/test-db.ts');
    await this.runPreparationStep(
      'target_database_creation',
      'fresh_target_allocation_failed',
      async () => {
        const created = await this.runChild(
          process.execPath,
          ['--import', 'tsx', testDb],
          this.targetEnv,
          deadline,
          'create-target',
          signal,
        );
        if (!created.utilityDiagnostic) throw new Basic5CiHold('utility_child_observation_missing');
        this.preflightResult?.utilityChildDiagnostics.push(created.utilityDiagnostic);
        assertBasic5CiUtilityChildSucceeded('target_database_creation', created);
        assertNotAborted(signal, 'prepare');
      },
    );
    await this.runPreparationStep(
      'target_marker_verification',
      'fresh_target_marker_verification_failed',
      () =>
        support.assertAllocatedTestTargetMarker({
          databaseUrl: target.databaseUrl,
          testDatabaseUrl: target.databaseUrl,
          token: target.token,
          kind: 'standard',
        }),
    );
    const dbPackage = await this.runPreparationStep(
      'database_module_import',
      'database_module_unavailable',
      async () => (await import('@assistant/db')) as unknown as DbModule,
    );
    this.dbModule = dbPackage;
    const db = await this.runPreparationStep(
      'database_connection_open',
      'database_connection_open_failed',
      () => dbPackage.createDb(target.databaseUrl, { max: 1, statementTimeoutMs: 5_000 }),
    );
    let databaseFailure: unknown;
    let poolCloseFailure: unknown;
    try {
      await this.runPreparationStep(
        'database_ownership_check',
        'allocated_database_ownership_check_failed',
        () => support.assertAllocatedTestDatabaseOwnership(db, target),
      );
      await this.runPreparationStep(
        'server_version_query',
        'target_postgres_version_unavailable',
        async () => {
          const [version] = await db.$client.unsafe('SHOW server_version_num');
          assertNotAborted(signal, 'prepare');
          const serverVersion = Number(version?.server_version_num);
          if (
            !Number.isSafeInteger(serverVersion) ||
            serverVersion < 170000 ||
            serverVersion >= 180000
          )
            throw new Basic5CiHold('target_postgres_not_version_17');
          const preflightResult = this.preflightResult;
          if (!preflightResult) throw new Basic5CiHold('preflight_observation_missing');
          preflightResult.postgresServerVersionNum = serverVersion;
        },
      );
    } catch (error) {
      databaseFailure = error;
    }
    try {
      await this.runPreparationStep('database_pool_close', 'database_pool_close_failed', () =>
        db.$client.end({ timeout: 3 }),
      );
    } catch (error) {
      poolCloseFailure = error;
    }
    if (databaseFailure && poolCloseFailure) {
      throw combineBasic5CiPreparationFailures(
        databaseFailure as Basic5CiHold,
        poolCloseFailure as Basic5CiHold,
      );
    }
    if (databaseFailure) throw databaseFailure;
    if (poolCloseFailure) throw poolCloseFailure;
    assertNotAborted(signal, 'prepare');
    await this.runPreparationStep('migration_child', 'fresh_target_migration_failed', async () => {
      const migrate = await this.runChild(
        process.execPath,
        ['--import', 'tsx', join(this.repoRoot, 'packages/db/src/migrate.ts')],
        this.targetEnv,
        deadline,
        'migrate',
        signal,
      );
      if (!migrate.utilityDiagnostic) throw new Basic5CiHold('utility_child_observation_missing');
      this.preflightResult?.utilityChildDiagnostics.push(migrate.utilityDiagnostic);
      assertBasic5CiUtilityChildSucceeded('migration_child', migrate);
      assertNotAborted(signal, 'prepare');
    });
    await this.runPreparationStep('seed_child', 'fresh_synthetic_seed_failed', async () => {
      const seed = await this.runChild(
        process.execPath,
        ['--import', 'tsx', join(this.repoRoot, 'packages/db/src/seed.ts')],
        this.targetEnv,
        deadline,
        'seed',
        signal,
      );
      if (!seed.utilityDiagnostic) throw new Basic5CiHold('utility_child_observation_missing');
      this.preflightResult?.utilityChildDiagnostics.push(seed.utilityDiagnostic);
      assertBasic5CiUtilityChildSucceeded('seed_child', seed);
      assertNotAborted(signal, 'prepare');
    });
    return target;
  }

  private async vitestConfig(): Promise<string> {
    const require = (await import('node:module')).createRequire(
      join(this.repoRoot, 'package.json'),
    );
    const configModule = require.resolve('vitest/config');
    const configPath = join(this.privateRoot, 'basic5-vitest.config.mjs');
    const baseUrl = pathToFileURL(join(this.repoRoot, 'vitest.config.ts')).href;
    const moduleUrl = pathToFileURL(configModule).href;
    const content = `import { mergeConfig } from ${JSON.stringify(moduleUrl)};\nimport base from ${JSON.stringify(baseUrl)};\nexport default mergeConfig(base, { root: ${JSON.stringify(this.repoRoot)}, test: { reporters: [['json', { stdout: true }]] } });\n`;
    await writeFile(configPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(configPath, 0o600);
    return configPath;
  }

  private parseVitest(
    stdout: Buffer,
    exitCode: number,
    stderr: Buffer = Buffer.alloc(0),
    observedExitCode: number | null = exitCode,
  ): Basic5CiCaseResult {
    const observation = observeBasic5CiVitestOutput({
      stdout,
      stderr,
      exitCode: observedExitCode,
      repoRoot: this.repoRoot,
    });
    const hold = (code: string): never => {
      throw new Basic5CiHold(
        code,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        observation.diagnostic,
      );
    };
    // Parse failed reports before rejecting the run; diagnostics never confer a PASS.
    if (observation.diagnostic.reportStatus === 'output_limit')
      hold('vitest_execution_failed_or_output_overflow');
    if (exitCode !== 0) hold('vitest_execution_failed_or_output_overflow');
    if (stderr.length) hold('vitest_stderr_not_empty');
    if (!observation.validOutput || !observation.summary) hold('vitest_json_summary_malformed');
    if (!observation.evidenceLine)
      hold('vitest_requires_one_summary_and_one_content_free_evidence_record');
    let evidence: Basic5CiEvidence;
    try {
      evidence = JSON.parse(observation.evidenceLine as string) as Basic5CiEvidence;
    } catch {
      return hold('acceptance_evidence_json_malformed');
    }
    const diagnostic = observation.diagnostic;
    if (
      observation.summary?.success !== true ||
      diagnostic.failed !== 0 ||
      !observation.knownCasePassed
    )
      hold('vitest_report_not_successful');
    return {
      exitCode,
      total: diagnostic.total as number,
      passed: diagnostic.passed as number,
      skipped: (diagnostic.pending as number) + (diagnostic.todo as number),
      failed: diagnostic.failed as number,
      evidence,
    };
  }

  async runExactCase(
    target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Basic5CiCaseResult> {
    this.assertDeadline(deadline, 'test');
    assertNotAborted(signal, 'test');
    if (!this.preflightResult || !this.targetSupport || this.target?.token !== target.token)
      throw new Basic5CiHold('ci_case_preconditions_missing');
    await this.runCaseEntryStep(
      'process_registry_precheck',
      'process_registry_precheck_failed',
      async () => {
        try {
          await lstat(this.registryPath);
          throw new Basic5CiHold('process_registry_preexisted');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    );
    const config = await this.runCaseEntryStep(
      'vitest_config_generation',
      'vitest_config_generation_failed',
      () => this.vitestConfig(),
    );
    assertNotAborted(signal, 'test');
    const env: NodeJS.ProcessEnv = {
      ...this.targetEnv,
      ASSISTANT_RUN_BASIC5_BROWSER_ACCEPTANCE: '1',
      ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE: '1',
      ASSISTANT_BASIC5_CI_REGISTRY_FILE: this.registryPath,
      ASSISTANT_BASIC5_STANDALONE_SOURCE_SHA: this.preflightResult.sourceCommit,
      ASSISTANT_BASIC5_STANDALONE_BUILD_ID: this.preflightResult.requiredArtifactIdentity.buildId,
      ASSISTANT_BASIC5_STANDALONE_SERVER_SHA256:
        this.preflightResult.requiredArtifactIdentity.serverSha256,
    };
    const vitest = await this.runCaseEntryStep(
      'vitest_entry_resolution',
      'vitest_entry_resolution_failed',
      async () => {
        const require = (await import('node:module')).createRequire(
          join(this.repoRoot, 'package.json'),
        );
        assertNotAborted(signal, 'test');
        const manifestPath = require.resolve('vitest/package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          name?: unknown;
          bin?: unknown;
        };
        if (
          manifest.name !== 'vitest' ||
          !manifest.bin ||
          typeof manifest.bin !== 'object' ||
          Array.isArray(manifest.bin) ||
          (manifest.bin as Record<string, unknown>).vitest !== './vitest.mjs'
        )
          throw new Basic5CiHold('vitest_cli_entry_manifest_unexpected');
        const packageDirectory = dirname(manifestPath);
        const entry = resolve(packageDirectory, 'vitest.mjs');
        const entryInfo = await lstat(entry);
        if (!entryInfo.isFile() || entryInfo.isSymbolicLink())
          throw new Basic5CiHold('vitest_cli_entry_not_regular_file');
        return entry;
      },
    );
    const args = [
      '--import',
      'tsx',
      vitest,
      'run',
      'scripts/basic5-browser-acceptance.integration.test.ts',
      '--project',
      'scripts',
      '--maxWorkers=1',
      '--config',
      config,
    ];
    const child = await this.runCaseEntryStep(
      'vitest_child_execution',
      'vitest_child_execution_failed',
      async () => {
        const result = await this.runChild(
          process.execPath,
          args,
          env,
          deadline,
          'basic5-vitest',
          signal,
        );
        return result;
      },
    );
    return this.runCaseEntryStep('vitest_output_parse', 'vitest_output_parse_failed', () =>
      this.parseVitest(child.stdout, child.exitCode, child.stderr, child.observedExitCode),
    );
  }

  async quiesceApplication(deadline: number, signal: AbortSignal): Promise<Basic5CiQuiescence> {
    try {
      return await this.observeAndQuiesceOwnedApplication(deadline, signal);
    } catch (error) {
      if (error instanceof Basic5CiHold) throw error;
      throw new Basic5CiHold('owned_application_quiescence_failed');
    }
  }

  private async observeAndQuiesceOwnedApplication(
    deadline: number,
    signal: AbortSignal,
  ): Promise<Basic5CiQuiescence> {
    this.assertDeadline(deadline, 'quiescence');
    assertNotAborted(signal, 'quiescence');
    if (!this.proof) throw new Basic5CiHold('linux_process_proof_unavailable');
    let registryError: Basic5CiHold | undefined;
    try {
      this.fixtureRecords = await this.proof.readBasic5CiProcessRegistry(this.registryPath);
      this.proof.assertBasic5CiProcessRegistryComplete(this.fixtureRecords);
      const browserRecord = this.fixtureRecords.find((record) => record.role === 'browser');
      if (
        browserRecord?.exe !== this.proof.BASIC5_CI_CHROME_EXECUTABLE ||
        this.fixtureRecords.some(
          (record) =>
            (record.role === 'web' || record.role === 'embedding') && record.port === undefined,
        )
      )
        throw new Basic5CiHold('fixture_process_registry_role_binding_invalid');
    } catch (error) {
      this.fixtureRecords = [];
      registryError =
        error instanceof Basic5CiHold
          ? error
          : new Basic5CiHold('fixture_process_registry_invalid');
    }
    await this.stopKnownSessions(deadline, signal);
    assertNotAborted(signal, 'quiescence');
    if (registryError) throw registryError;
    const [live, listeners] = await Promise.all([
      this.proof.readBasic5LinuxProcessSnapshot(),
      this.readListeners(),
    ]);
    const listeningPorts = new Set(listeners.values());
    this.proof.assertBasic5CiProcessClosure(this.fixtureRecords, live, listeningPorts);
    let liveOwnedProcesses = 0;
    let unknownProcesses = 0;
    const ownedSessions = new Set([...this.ownedRoots.values()].map((identity) => identity.sid));
    const fixturePidStarts = new Map(
      this.fixtureRecords.map((record) => [record.pid, record.startTimeTicks]),
    );
    for (const [pid, row] of live) {
      if (fixturePidStarts.has(pid)) {
        if (fixturePidStarts.get(pid) !== row.startTimeTicks) unknownProcesses += 1;
        else liveOwnedProcesses += 1;
      } else if (ownedSessions.has(row.sid)) {
        liveOwnedProcesses += 1;
      }
    }
    for (const root of this.ownedRoots.values()) {
      const leader = live.get(root.pid);
      if (leader && leader.startTimeTicks !== root.startTimeTicks) unknownProcesses += 1;
    }
    const newListeners = [...listeners.keys()].filter((key) => !this.baselineListeners.has(key));
    const roles = this.fixtureRecords.map((record) => record.role).sort();
    return {
      known: unknownProcesses === 0,
      registeredRoles: roles,
      liveOwnedProcesses,
      liveOwnedListeners: newListeners.length,
      unknownProcesses,
      fixtureRegistryValid: roles.length === 4,
    };
  }

  async cleanupExactTarget(
    target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertDeadline(deadline, 'target_cleanup');
    assertNotAborted(signal, 'target_cleanup');
    if (this.target?.token !== target.token)
      throw new Basic5CiHold('cleanup_target_token_mismatch');
    const result = await this.runChild(
      process.execPath,
      ['--import', 'tsx', join(this.repoRoot, 'packages/db/src/cleanup-test-db.ts')],
      this.targetEnv,
      deadline,
      'target-cleanup',
      signal,
    );
    if (result.exitCode !== 0 || result.stderr.length)
      throw new Basic5CiHold('exact_target_cleanup_failed');
  }

  async verifyTargetAbsent(
    target: Basic5CiTarget,
    deadline: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.assertDeadline(deadline, 'target_absence');
    assertNotAborted(signal, 'target_absence');
    if (!this.dbModule) throw new Basic5CiHold('database_driver_unavailable_for_absence_check');
    const adminUrl = new URL(target.databaseUrl);
    adminUrl.pathname = '/postgres';
    const client = this.dbModule.createDb(adminUrl.toString(), {
      max: 1,
      connectTimeoutSeconds: 5,
      statementTimeoutMs: 5_000,
    });
    let absent = false;
    try {
      const rows = await client.$client.unsafe(
        'SELECT datname FROM pg_database WHERE datname = $1',
        [target.databaseName],
      );
      absent = rows.length === 0;
      assertNotAborted(signal, 'target_absence');
    } finally {
      await client.$client.end({ timeout: 3 });
    }
    assertNotAborted(signal, 'target_absence');
    try {
      const support = this.targetSupport;
      if (!support) throw new Basic5CiHold('test_target_support_unavailable');
      await lstat(support.testTargetMarkerPath(target.token));
    } catch (error) {
      return absent && (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    return false;
  }

  async writeContentFreeReceipt(
    receipt: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal, 'receipt_write');
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
}

export async function main(): Promise<number> {
  if (process.env.ASSISTANT_RUN_BASIC5_CI_ACCEPTANCE !== '1') return 0;
  const ops = new RealBasic5CiOps();
  try {
    const result = await runBasic5CiAcceptance(ops);
    return result.result === 'passed' ? 0 : 1;
  } finally {
    ops.dispose();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
