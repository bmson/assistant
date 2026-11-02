import type {
  Basic5ReplyObservation,
  Basic5SaveObservationDiagnostic,
} from './basic5-browser-save-observation.js';

/** Bounded projection of the pinned Vitest JSON reporter; never retain raw errors. */
const CAPTURE_BYTES = 64 * 1024;
const FIXTURE = 'scripts/basic5-browser-acceptance.integration.test.ts';
const SUPPORT = 'scripts/basic5-browser-acceptance-support.ts';
const SAVE = 'scripts/basic5-browser-save-observation.ts';
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
export type Basic5AnonymousLocationClass =
  | 'absent'
  | 'same_origin_signin'
  | 'other_same_origin'
  | 'off_origin'
  | 'invalid';

/** Only a fixed destination class leaves the fixture; never retain a Location URL. */
export function classifyBasic5AnonymousLocation(
  location: string | undefined,
  baseUrl: string,
): Basic5AnonymousLocationClass {
  if (location === undefined) return 'absent';
  if (!location || location.length > 2048) return 'invalid';
  try {
    const base = new URL(baseUrl);
    const target = new URL(location, base);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return 'invalid';
    if (target.origin !== base.origin) return 'off_origin';
    return target.pathname === '/api/auth/signin' && !target.search && !target.hash
      ? 'same_origin_signin'
      : 'other_same_origin';
  } catch {
    return 'invalid';
  }
}

function safeReplyObservation(value: unknown): Basic5ReplyObservation | null {
  const keys = [
    'step',
    'contentTypeClass',
    'decoderCallable',
    'jsonReadCompleted',
    'topLevelObject',
    'wireKeysAllowed',
    'receiptKeysPresent',
    'versionTypeNumber',
    'versionOne',
    'wireTypesValid',
    'decoderAccepted',
  ];
  const nullable = [
    'topLevelObject',
    'wireKeysAllowed',
    'receiptKeysPresent',
    'versionTypeNumber',
    'versionOne',
    'wireTypesValid',
    'decoderAccepted',
  ];
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    !['response_json', 'reply_decode', 'reply_decoded'].includes(
      typeof value.step === 'string' ? value.step : '',
    ) ||
    !['json', 'html', 'other', 'missing', 'unknown'].includes(
      typeof value.contentTypeClass === 'string' ? value.contentTypeClass : '',
    ) ||
    typeof value.decoderCallable !== 'boolean' ||
    typeof value.jsonReadCompleted !== 'boolean' ||
    nullable.some((key) => value[key] !== null && typeof value[key] !== 'boolean') ||
    (!value.jsonReadCompleted && nullable.some((key) => value[key] !== null)) ||
    (value.step === 'response_json' ? value.jsonReadCompleted : !value.jsonReadCompleted) ||
    (value.decoderAccepted === true &&
      (!value.decoderCallable || value.step !== 'reply_decoded')) ||
    (value.step === 'reply_decoded' && value.decoderAccepted !== true) ||
    (value.versionOne === true && value.versionTypeNumber !== true)
  )
    return null;
  return Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as unknown as Basic5ReplyObservation;
}

function safeSaveObservation(value: unknown): Basic5SaveObservationDiagnostic | null {
  const keys = [
    'operation',
    'phase',
    'totalMatchingPostCount',
    'commandMatched',
    'httpStatus',
    'nativeValid',
    'invalidControlPresent',
    'alertPresent',
    'saveEnabled',
    'pageClosed',
    'errorStage',
    'errorCategory',
  ];
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length + (Object.hasOwn(value, 'reply') ? 1 : 0) ||
    (Object.hasOwn(value, 'reply') && !safeReplyObservation(value.reply)) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    ![
      'update_person_identity',
      'add_family_relationship',
      'correct_owner_family_relationship',
      'correct_owner_memory',
    ].includes(typeof value.operation === 'string' ? value.operation : '') ||
    !['click_pending', 'click_done', 'request_seen', 'response_seen', 'parse'].includes(
      typeof value.phase === 'string' ? value.phase : '',
    ) ||
    !(
      value.totalMatchingPostCount === null ||
      (count(value.totalMatchingPostCount) && value.totalMatchingPostCount <= 64)
    ) ||
    !(
      value.httpStatus === null ||
      (Number.isInteger(value.httpStatus) &&
        Number(value.httpStatus) >= 100 &&
        Number(value.httpStatus) <= 599)
    ) ||
    ![
      'commandMatched',
      'nativeValid',
      'invalidControlPresent',
      'alertPresent',
      'saveEnabled',
    ].every((key) => value[key] === null || typeof value[key] === 'boolean') ||
    typeof value.pageClosed !== 'boolean' ||
    !(
      value.errorStage === null ||
      ['click', 'wait', 'parse'].includes(
        typeof value.errorStage === 'string' ? value.errorStage : '',
      )
    ) ||
    !(
      value.errorCategory === null ||
      ['timeout', 'page_closed', 'other'].includes(
        typeof value.errorCategory === 'string' ? value.errorCategory : '',
      )
    )
  )
    return null;
  return {
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    ...(Object.hasOwn(value, 'reply') ? { reply: safeReplyObservation(value.reply) } : {}),
  } as unknown as Basic5SaveObservationDiagnostic;
}

export type Basic5FixtureCounters = {
  observedAt: 'save_settled' | 'checkpoint';
  browserHttpRequests: number | null;
  browserBudgetExceeded: boolean;
  localEmbeddingReceived: number | null;
  localEmbeddingFinished: number | null;
};
export type Basic5SaveTransport = {
  operation: Basic5SaveObservationDiagnostic['operation'];
  routeBlocked: boolean | null;
  requestFailedClass:
    | 'blocked_by_client'
    | 'aborted'
    | 'connection'
    | 'timeout'
    | 'name_resolution'
    | 'other'
    | 'unknown'
    | null;
};
function safeFixtureCounters(value: unknown): Basic5FixtureCounters | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 5 ||
    !['save_settled', 'checkpoint'].includes(
      typeof value.observedAt === 'string' ? value.observedAt : '',
    ) ||
    typeof value.browserBudgetExceeded !== 'boolean' ||
    !['browserHttpRequests', 'localEmbeddingReceived', 'localEmbeddingFinished'].every(
      (key) => Object.hasOwn(value, key) && (value[key] === null || count(value[key])),
    ) ||
    (typeof value.localEmbeddingReceived === 'number' &&
      typeof value.localEmbeddingFinished === 'number' &&
      value.localEmbeddingFinished > value.localEmbeddingReceived)
  )
    return null;
  return {
    observedAt: value.observedAt,
    browserHttpRequests: value.browserHttpRequests,
    browserBudgetExceeded: value.browserBudgetExceeded,
    localEmbeddingReceived: value.localEmbeddingReceived,
    localEmbeddingFinished: value.localEmbeddingFinished,
  } as Basic5FixtureCounters;
}
function safeSaveTransport(value: unknown): Basic5SaveTransport | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    ![
      'update_person_identity',
      'add_family_relationship',
      'correct_owner_family_relationship',
      'correct_owner_memory',
    ].includes(typeof value.operation === 'string' ? value.operation : '') ||
    !(value.routeBlocked === null || typeof value.routeBlocked === 'boolean') ||
    !(
      value.requestFailedClass === null ||
      [
        'blocked_by_client',
        'aborted',
        'connection',
        'timeout',
        'name_resolution',
        'other',
        'unknown',
      ].includes(typeof value.requestFailedClass === 'string' ? value.requestFailedClass : '')
    )
  )
    return null;
  return {
    operation: value.operation,
    routeBlocked: value.routeBlocked,
    requestFailedClass: value.requestFailedClass,
  } as Basic5SaveTransport;
}

export type Basic5CiFixtureCheckpoint = {
  schemaVersion: 1;
  stage: string;
  authenticatedNavigationCount: number;
  applyCount: number;
  durableReadbackCount: number;
  freshPageReadbackCount: number;
  anonymousPageStatus?: number;
  anonymousLocationClass?: Basic5AnonymousLocationClass;
  saveObservation?: Basic5SaveObservationDiagnostic;
  fixtureCounters?: Basic5FixtureCounters;
  saveTransport?: Basic5SaveTransport;
};

function safeCheckpoint(value: unknown): Basic5CiFixtureCheckpoint | null {
  if (
    !record(value) ||
    Object.keys(value).length !==
      (Object.hasOwn(value, 'anonymousPageStatus') ? 8 : 6) +
        (Object.hasOwn(value, 'saveObservation') ? 1 : 0) +
        (Object.hasOwn(value, 'fixtureCounters') ? 1 : 0) +
        (Object.hasOwn(value, 'saveTransport') ? 1 : 0) ||
    (Object.hasOwn(value, 'fixtureCounters') && !safeFixtureCounters(value.fixtureCounters)) ||
    (Object.hasOwn(value, 'saveTransport') && !safeSaveTransport(value.saveTransport)) ||
    (Object.hasOwn(value, 'saveObservation') && !safeSaveObservation(value.saveObservation)) ||
    Object.hasOwn(value, 'anonymousPageStatus') !==
      Object.hasOwn(value, 'anonymousLocationClass') ||
    (Object.hasOwn(value, 'anonymousPageStatus') &&
      (!Number.isInteger(value.anonymousPageStatus) ||
        Number(value.anonymousPageStatus) < 100 ||
        Number(value.anonymousPageStatus) > 599 ||
        typeof value.anonymousLocationClass !== 'string' ||
        !['absent', 'same_origin_signin', 'other_same_origin', 'off_origin', 'invalid'].includes(
          value.anonymousLocationClass,
        ))) ||
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
    ...(Object.hasOwn(value, 'fixtureCounters')
      ? { fixtureCounters: safeFixtureCounters(value.fixtureCounters) as Basic5FixtureCounters }
      : {}),
    ...(Object.hasOwn(value, 'saveTransport')
      ? { saveTransport: safeSaveTransport(value.saveTransport) as Basic5SaveTransport }
      : {}),
    ...(Object.hasOwn(value, 'saveObservation')
      ? {
          saveObservation: safeSaveObservation(
            value.saveObservation,
          ) as Basic5SaveObservationDiagnostic,
        }
      : {}),
    ...(Object.hasOwn(value, 'anonymousPageStatus')
      ? {
          anonymousPageStatus: Number(value.anonymousPageStatus),
          anonymousLocationClass: value.anonymousLocationClass as Basic5AnonymousLocationClass,
        }
      : {}),
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
  firstSourceFrame: {
    file: typeof FIXTURE | typeof SUPPORT | typeof SAVE;
    line: number;
    column: number;
  } | null;
  checkpoint: Basic5CiFixtureCheckpoint | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function reviewedPath(
  value: unknown,
  repoRoot: string,
): typeof FIXTURE | typeof SUPPORT | typeof SAVE | null {
  if (value === FIXTURE || value === `${repoRoot}/${FIXTURE}`) return FIXTURE;
  if (value === SUPPORT || value === `${repoRoot}/${SUPPORT}`) return SUPPORT;
  if (value === SAVE || value === `${repoRoot}/${SAVE}`) return SAVE;
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
      ![FIXTURE, SUPPORT, SAVE].includes(frame.file) ||
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
