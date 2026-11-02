/** Bounded projection of the pinned Vitest JSON reporter; never retain raw errors. */
const CAPTURE_BYTES = 64 * 1024;
const FIXTURE = 'scripts/basic5-browser-acceptance.integration.test.ts';
const SUPPORT = 'scripts/basic5-browser-acceptance-support.ts';
const CASE_TITLE =
  'four BASIC5 saves produce exact receipts and fresh PostgreSQL readbacks through Auth.js';
const EVIDENCE_PREFIX = 'BASIC5_ACCEPTANCE_EVIDENCE ';
const CHECKPOINT_PREFIX = 'BASIC5_ACCEPTANCE_CHECKPOINT ';
const CHECKPOINT_STAGES = [
  'fixture_setup_started',
  'fixture_prepared',
  'case_complete',
  'web_ready',
  'browser_launch_started',
  'browser_launched',
  'anonymous_probe_complete',
  'auth_cookie_installed',
  'authenticated_navigation_complete',
  ...['identity', 'family_add', 'family_correction', 'note_correction'].flatMap((operation) =>
    ['apply_complete', 'durable_readback_complete', 'fresh_page_readback_complete'].map(
      (stage) => `${operation}_${stage}`,
    ),
  ),
];
export type Basic5CiFixtureCheckpoint = {
  schemaVersion: 1;
  stage: string;
  authenticatedNavigationCount: number;
  applyCount: number;
  durableReadbackCount: number;
  freshPageReadbackCount: number;
};

function safeCheckpoint(value: unknown): Basic5CiFixtureCheckpoint | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 6 ||
    value.schemaVersion !== 1 ||
    typeof value.stage !== 'string' ||
    !CHECKPOINT_STAGES.includes(value.stage) ||
    !count(value.authenticatedNavigationCount) ||
    value.authenticatedNavigationCount > 6 ||
    !['applyCount', 'durableReadbackCount', 'freshPageReadbackCount'].every(
      (key) => count(value[key]) && Number(value[key]) <= 4,
    )
  )
    return null;
  return {
    schemaVersion: 1,
    stage: String(value.stage),
    authenticatedNavigationCount: value.authenticatedNavigationCount,
    applyCount: Number(value.applyCount),
    durableReadbackCount: Number(value.durableReadbackCount),
    freshPageReadbackCount: Number(value.freshPageReadbackCount),
  };
}

export type Basic5CiVitestDiagnostic = {
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  reportStatus: 'parsed' | 'missing' | 'malformed' | 'output_limit';
  total: number | null;
  passed: number | null;
  failed: number | null;
  pending: number | null;
  todo: number | null;
  knownCaseFailed: boolean | null;
  errorCategory:
    | 'none'
    | 'assertion_failure'
    | 'test_timeout'
    | 'type_error'
    | 'syntax_error'
    | 'import_error'
    | 'runner_failure'
    | 'unknown';
  firstSourceFrame: { file: typeof FIXTURE | typeof SUPPORT; line: number; column: number } | null;
  checkpoint: Basic5CiFixtureCheckpoint | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function reviewedPath(value: unknown, repoRoot: string): typeof FIXTURE | typeof SUPPORT | null {
  if (value === FIXTURE || value === `${repoRoot}/${FIXTURE}`) return FIXTURE;
  if (value === SUPPORT || value === `${repoRoot}/${SUPPORT}`) return SUPPORT;
  return null;
}

function safeFirstFrame(
  message: string,
  repoRoot: string,
): Basic5CiVitestDiagnostic['firstSourceFrame'] {
  const first = message.split(/\r?\n/).find((line) => /^\s+at\s/.test(line));
  if (!first) return null;
  // Function names, error text and absolute roots never leave this projection.
  const match = /^\s+at (?:[^()\r\n]* \()?([^()\r\n]+):(\d+):(\d+)\)?$/.exec(first);
  if (!match) return null;
  const file = reviewedPath(match[1], repoRoot);
  const line = Number(match[2]);
  const column = Number(match[3]);
  return file && count(line) && line > 0 && count(column) && column > 0
    ? { file, line, column }
    : null;
}

function category(message: string): Basic5CiVitestDiagnostic['errorCategory'] {
  if (/^AssertionError\b/.test(message)) return 'assertion_failure';
  if (/^(?:TimeoutError\b|Error: Test timed out\b)/.test(message)) return 'test_timeout';
  if (/^TypeError\b/.test(message)) return 'type_error';
  if (/^SyntaxError\b/.test(message)) return 'syntax_error';
  if (
    /^(?:Error: Cannot find (?:module|package)\b|Error: Failed to (?:resolve|load)\b)/.test(message)
  )
    return 'import_error';
  return 'unknown';
}

export function observeBasic5CiVitestOutput(input: {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  repoRoot: string;
}): {
  diagnostic: Basic5CiVitestDiagnostic;
  summary: Record<string, unknown> | null;
  evidenceLine: string | null;
  validOutput: boolean;
  knownCasePassed: boolean;
} {
  const diagnostic: Basic5CiVitestDiagnostic = {
    exitCode: Number.isSafeInteger(input.exitCode) ? input.exitCode : null,
    stdoutBytes: input.stdout.byteLength,
    stderrBytes: input.stderr.byteLength,
    reportStatus: 'missing',
    total: null,
    passed: null,
    failed: null,
    pending: null,
    todo: null,
    knownCaseFailed: null,
    errorCategory: 'unknown',
    firstSourceFrame: null,
    checkpoint: null,
  };
  if (input.stdout.byteLength + input.stderr.byteLength > CAPTURE_BYTES) {
    diagnostic.reportStatus = 'output_limit';
    return {
      diagnostic,
      summary: null,
      evidenceLine: null,
      validOutput: false,
      knownCasePassed: false,
    };
  }
  const summaries: Record<string, unknown>[] = [];
  const evidence: string[] = [];
  const checkpoints: unknown[] = [];
  let recognized = true;
  for (const line of input.stdout.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(EVIDENCE_PREFIX)) evidence.push(line.slice(EVIDENCE_PREFIX.length));
    else if (line.startsWith(CHECKPOINT_PREFIX)) {
      try {
        checkpoints.push(JSON.parse(line.slice(CHECKPOINT_PREFIX.length)));
      } catch {
        recognized = false;
      }
    } else {
      try {
        const value: unknown = JSON.parse(line);
        if (record(value) && Object.hasOwn(value, 'numTotalTests')) summaries.push(value);
        else recognized = false;
      } catch {
        recognized = false;
      }
    }
  }
  if (checkpoints.length === 1) {
    diagnostic.checkpoint = safeCheckpoint(checkpoints[0]);
    if (!diagnostic.checkpoint) recognized = false;
  } else if (checkpoints.length > 1) recognized = false;
  const summary = summaries.length === 1 ? (summaries[0] ?? null) : null;
  const fields = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
  ];
  if (
    !summary ||
    fields.some((key) => !count(summary[key])) ||
    Number(summary.numPassedTests) +
      Number(summary.numFailedTests) +
      Number(summary.numPendingTests) +
      Number(summary.numTodoTests) !==
      summary.numTotalTests
  ) {
    if (summaries.length || !recognized) diagnostic.reportStatus = 'malformed';
    return {
      diagnostic,
      summary: null,
      evidenceLine: null,
      validOutput: false,
      knownCasePassed: false,
    };
  }
  diagnostic.reportStatus = 'parsed';
  diagnostic.total = Number(summary.numTotalTests);
  diagnostic.passed = Number(summary.numPassedTests);
  diagnostic.failed = Number(summary.numFailedTests);
  diagnostic.pending = Number(summary.numPendingTests);
  diagnostic.todo = Number(summary.numTodoTests);
  diagnostic.errorCategory =
    diagnostic.failed === 0 && summary.success === true ? 'none' : 'runner_failure';
  const suiteFields = [
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ];
  if (
    suiteFields.some((key) => !count(summary[key])) ||
    Number(summary.numPassedTestSuites) +
      Number(summary.numFailedTestSuites) +
      Number(summary.numPendingTestSuites) !==
      summary.numTotalTestSuites ||
    (summary.success === true &&
      (summary.numFailedTestSuites !== 0 ||
        summary.numPendingTestSuites !== 0 ||
        summary.numTotalTestSuites !== 1))
  )
    recognized = false;
  const results = summary.testResults;
  let knownCasePassed = false;
  let exactCaseCount = 0;
  if (
    Array.isArray(results) &&
    results.every(
      (row) =>
        record(row) &&
        typeof row.name === 'string' &&
        ['passed', 'failed'].includes(typeof row.status === 'string' ? row.status : '') &&
        Array.isArray(row.assertionResults) &&
        row.assertionResults.every(
          (test: unknown) =>
            record(test) &&
            typeof test.title === 'string' &&
            typeof test.fullName === 'string' &&
            ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(
              String(test.status),
            ) &&
            Array.isArray(test.failureMessages) &&
            test.failureMessages.every((message: unknown) => typeof message === 'string'),
        ),
    )
  ) {
    if (
      results.length > Number(summary.numTotalTestSuites) ||
      results.filter((row) => row.status === 'passed').length >
        Number(summary.numPassedTestSuites) ||
      results.filter((row) => row.status === 'failed').length > Number(summary.numFailedTestSuites)
    )
      recognized = false;
    const assertions = results.flatMap((row) => row.assertionResults as Record<string, unknown>[]);
    const statusCount = (status: string) =>
      assertions.filter((test) => test.status === status).length;
    const detailConsistent =
      assertions.length === diagnostic.total &&
      statusCount('passed') === diagnostic.passed &&
      statusCount('failed') === diagnostic.failed &&
      statusCount('todo') === diagnostic.todo &&
      statusCount('pending') + statusCount('skipped') + statusCount('disabled') ===
        diagnostic.pending &&
      (summary.success !== true || results.every((row) => row.status !== 'failed'));
    if (!detailConsistent) recognized = false;
    diagnostic.knownCaseFailed = detailConsistent ? false : null;
    for (const row of results) {
      if (!record(row) || reviewedPath(row.name, input.repoRoot) !== FIXTURE) continue;
      if (
        typeof row.message === 'string' &&
        row.message &&
        diagnostic.errorCategory === 'runner_failure'
      )
        diagnostic.errorCategory = category(row.message);
      for (const test of row.assertionResults as unknown[]) {
        if (record(test) && test.title === CASE_TITLE && test.fullName === CASE_TITLE)
          exactCaseCount += 1;
        if (
          record(test) &&
          test.title === CASE_TITLE &&
          test.fullName === CASE_TITLE &&
          test.status === 'passed' &&
          detailConsistent
        )
          knownCasePassed = true;
        if (
          !record(test) ||
          test.title !== CASE_TITLE ||
          test.fullName !== CASE_TITLE ||
          test.status !== 'failed'
        )
          continue;
        diagnostic.knownCaseFailed = true;
        const first = Array.isArray(test.failureMessages) ? test.failureMessages[0] : undefined;
        if (typeof first === 'string') {
          diagnostic.errorCategory = category(first);
          diagnostic.firstSourceFrame = safeFirstFrame(first, input.repoRoot);
        }
      }
    }
  } else recognized = false;
  return {
    diagnostic,
    summary,
    evidenceLine:
      evidence.length === 1 && Buffer.byteLength(evidence[0] ?? '') <= 16_384
        ? (evidence[0] ?? null)
        : null,
    validOutput: recognized && evidence.length <= 1 && typeof summary.success === 'boolean',
    knownCasePassed: recognized && knownCasePassed && exactCaseCount === 1,
  };
}

export function contentFreeBasic5CiVitestDiagnostic(value: unknown): Basic5CiVitestDiagnostic {
  if (!record(value)) throw new Error('vitest_diagnostic_invalid');
  const keys = [
    'exitCode',
    'stdoutBytes',
    'stderrBytes',
    'reportStatus',
    'total',
    'passed',
    'failed',
    'pending',
    'todo',
    'knownCaseFailed',
    'errorCategory',
    'firstSourceFrame',
    'checkpoint',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    !(
      value.exitCode === null ||
      (Number.isSafeInteger(value.exitCode) &&
        Number(value.exitCode) >= 0 &&
        Number(value.exitCode) <= 255)
    ) ||
    !['stdoutBytes', 'stderrBytes'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    ) ||
    typeof value.reportStatus !== 'string' ||
    !['parsed', 'missing', 'malformed', 'output_limit'].includes(value.reportStatus) ||
    !['total', 'passed', 'failed', 'pending', 'todo'].every(
      (key) => value[key] === null || count(value[key]),
    ) ||
    ![null, true, false].includes(value.knownCaseFailed as boolean | null) ||
    ![
      'none',
      'assertion_failure',
      'test_timeout',
      'type_error',
      'syntax_error',
      'import_error',
      'runner_failure',
      'unknown',
    ].includes(typeof value.errorCategory === 'string' ? value.errorCategory : '')
  )
    throw new Error('vitest_diagnostic_invalid');
  const frame = value.firstSourceFrame;
  if (value.checkpoint !== null && !safeCheckpoint(value.checkpoint))
    throw new Error('vitest_diagnostic_invalid');
  const counts = ['total', 'passed', 'failed', 'pending', 'todo'];
  if (
    value.reportStatus === 'parsed'
      ? counts.some((key) => value[key] === null)
      : counts.some((key) => value[key] !== null)
  )
    throw new Error('vitest_diagnostic_invalid');
  if (
    value.reportStatus === 'parsed' &&
    Number(value.passed) + Number(value.failed) + Number(value.pending) + Number(value.todo) !==
      value.total
  )
    throw new Error('vitest_diagnostic_invalid');
  if (
    value.reportStatus !== 'parsed' &&
    (value.knownCaseFailed !== null || frame !== null || value.errorCategory !== 'unknown')
  )
    throw new Error('vitest_diagnostic_invalid');
  if (frame !== null && value.knownCaseFailed !== true)
    throw new Error('vitest_diagnostic_invalid');
  if (
    frame !== null &&
    (!record(frame) ||
      Object.keys(frame).length !== 3 ||
      typeof frame.file !== 'string' ||
      ![FIXTURE, SUPPORT].includes(frame.file) ||
      !count(frame.line) ||
      frame.line < 1 ||
      !count(frame.column) ||
      frame.column < 1)
  )
    throw new Error('vitest_diagnostic_invalid');
  return {
    ...value,
    checkpoint: value.checkpoint === null ? null : safeCheckpoint(value.checkpoint),
    firstSourceFrame:
      frame === null
        ? null
        : {
            file: (frame as Record<string, unknown>).file,
            line: (frame as Record<string, unknown>).line,
            column: (frame as Record<string, unknown>).column,
          },
  } as Basic5CiVitestDiagnostic;
}

/** Stream capture exhausted before a complete report could be parsed. */
export function basic5CiVitestCaptureLimit(
  exitCode: number | null,
  stdoutBytes: number,
  stderrBytes: number,
): Basic5CiVitestDiagnostic {
  const { diagnostic } = observeBasic5CiVitestOutput({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 1,
    repoRoot: '',
  });
  return { ...diagnostic, exitCode, stdoutBytes, stderrBytes, reportStatus: 'output_limit' };
}
