import { describe, expect, it } from 'vitest';
import {
  type Basic5CiCaseResult,
  Basic5CiHold,
  RealBasic5CiOps,
  runBasic5CiCaseEntryStep,
} from './basic5-ci-acceptance.js';
import {
  basic5CiVitestCaptureLimit,
  contentFreeBasic5CiVitestDiagnostic,
  observeBasic5CiVitestOutput,
} from './basic5-ci-vitest-diagnostics.js';

const repoRoot = '/reviewed/assistant';
const fixture = 'scripts/basic5-browser-acceptance.integration.test.ts';
const knownTitle =
  'four BASIC5 saves produce exact receipts and fresh PostgreSQL readbacks through Auth.js';
const privateText = 'private-cookie=secret-token <html>private-form-value</html>';

/** Shape emitted by the installed Vitest 5 JSON reporter, without private payloads. */
function report(
  options: {
    title?: string;
    stack?: string;
    status?: 'passed' | 'failed' | 'pending';
    file?: string;
  } = {},
) {
  const status = options.status ?? 'failed';
  return {
    numTotalTestSuites: 1,
    numPassedTestSuites: status === 'passed' ? 1 : 0,
    numFailedTestSuites: status === 'failed' ? 1 : 0,
    numPendingTestSuites: status === 'pending' ? 1 : 0,
    numTotalTests: 1,
    numPassedTests: status === 'passed' ? 1 : 0,
    numFailedTests: status === 'failed' ? 1 : 0,
    numPendingTests: status === 'pending' ? 1 : 0,
    numTodoTests: 0,
    snapshot: {},
    startTime: 1,
    success: status === 'passed',
    testResults: [
      {
        assertionResults: [
          {
            ancestorTitles: [],
            fullName: options.title ?? knownTitle,
            status,
            title: options.title ?? knownTitle,
            duration: 15_130,
            failureMessages:
              status === 'failed'
                ? [
                    options.stack ??
                      `AssertionError: ${privateText}\n    at ${repoRoot}/${fixture}:700:12`,
                  ]
                : [],
            location: { line: 400, column: 1 },
            meta: {},
            tags: [],
          },
        ],
        startTime: 1,
        endTime: 15_131,
        status: status === 'failed' ? 'failed' : 'passed',
        message: '',
        name: options.file ?? `${repoRoot}/${fixture}`,
      },
    ],
  };
}

function observe(value: unknown, exitCode: number | null = 1, stderr = '') {
  const stdout = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return observeBasic5CiVitestOutput({
    stdout,
    stderr: Buffer.from(stderr),
    exitCode,
    repoRoot,
  });
}

function parseThroughController(value: unknown, exitCode = 1, stderr = '') {
  // No constructor, child handle, clock, filesystem or process census is needed
  // to exercise the real controller's pure report projection and HOLD path.
  const ops = Object.assign(Object.create(RealBasic5CiOps.prototype), { repoRoot }) as {
    parseVitest(stdout: Buffer, exitCode: number, stderr: Buffer): Basic5CiCaseResult;
  };
  return ops.parseVitest(
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    exitCode,
    Buffer.from(stderr),
  );
}

function withEvidence(value: unknown) {
  // The pure parse test leaves domain evidence validation to the controller's
  // independent existing acceptance gate; this record conveys no PASS authority.
  return `BASIC5_ACCEPTANCE_EVIDENCE {}\n${JSON.stringify(value)}`;
}

describe('BASIC5 bounded failed Vitest report diagnostics', () => {
  it('retains actual failed counts and known-case membership on runner exit one without evidence', () => {
    const value = report();
    const result = observe(value, 1, `runner diagnostic ${privateText}`);
    expect(result.diagnostic).toMatchObject({
      exitCode: 1,
      stdoutBytes: Buffer.byteLength(JSON.stringify(value)),
      stderrBytes: Buffer.byteLength(`runner diagnostic ${privateText}`),
      reportStatus: 'parsed',
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
      todo: 0,
      knownCaseFailed: true,
      errorCategory: 'assertion_failure',
      firstSourceFrame: { file: fixture, line: 700, column: 12 },
    });
    expect(result.evidenceLine).toBeNull();
    expect(result.validOutput).toBe(true);
    const encoded = JSON.stringify(result.diagnostic);
    expect(encoded).not.toContain(privateText);
    expect(encoded).not.toContain(repoRoot);
    expect(encoded).not.toContain(knownTitle);
    expect(contentFreeBasic5CiVitestDiagnostic(result.diagnostic)).toEqual(result.diagnostic);
  });

  it('does not turn runner exit zero with failed tests into successful test counts', () => {
    const result = observe(report(), 0);
    expect(result.diagnostic).toMatchObject({ exitCode: 0, failed: 1, passed: 0 });
    expect(result.summary?.success).toBe(false);
  });

  it('reports a different failed title only as known-case membership false', () => {
    const result = observe(report({ title: `unexpected ${privateText}` }));
    expect(result.diagnostic.knownCaseFailed).toBe(false);
    expect(JSON.stringify(result.diagnostic)).not.toContain(privateText);
  });

  it('does not attribute a matching title from another file to the reviewed case', () => {
    const result = observe(report({ file: '/unreviewed/other.test.ts' }));
    expect(result.diagnostic.knownCaseFailed).toBe(false);
  });

  it('strips function names and absolute prefixes from an allowed first source frame', () => {
    const result = observe(
      report({
        stack: `TypeError: ${privateText}\n    at privateFunction (${repoRoot}/${fixture}:42:7)`,
      }),
    );
    expect(result.diagnostic).toMatchObject({
      errorCategory: 'type_error',
      firstSourceFrame: { file: fixture, line: 42, column: 7 },
    });
    expect(JSON.stringify(result.diagnostic)).not.toMatch(
      /privateFunction|private-cookie|reviewed\/assistant/,
    );
  });

  it('does not skip an unreviewed first stack frame to expose a later reviewed frame', () => {
    const result = observe(
      report({
        stack: `AssertionError: ${privateText}\n    at /unreviewed/private.ts:1:2\n    at ${repoRoot}/${fixture}:700:12`,
      }),
    );
    expect(result.diagnostic.firstSourceFrame).toBeNull();
  });

  it.each([
    `AssertionError: ${privateText}\n    at https://example.test/${fixture}:42:7`,
    `AssertionError: ${privateText}\n    at ${repoRoot}/${fixture}/../../private.ts:42:7`,
    `AssertionError: ${privateText}\n    at /different-root/${fixture}:42:7`,
  ])('omits non-allowlisted stack locations', (stack) => {
    const result = observe(report({ stack }));
    expect(result.diagnostic.firstSourceFrame).toBeNull();
  });

  it('keeps unavailable report counts unknown rather than zero', () => {
    const result = observe('');
    expect(result.diagnostic).toMatchObject({
      exitCode: 1,
      reportStatus: 'missing',
      total: null,
      passed: null,
      failed: null,
      pending: null,
      todo: null,
      knownCaseFailed: null,
      firstSourceFrame: null,
    });
    expect(result.summary).toBeNull();
  });

  it.each(['{not-json', 'null', '{}'])(
    'rejects malformed reporter output without retaining it',
    (text) => {
      const result = observe(text);
      expect(result.validOutput).toBe(false);
      expect(result.diagnostic.reportStatus).toBe('malformed');
      expect(result.diagnostic.total).toBeNull();
      expect(result.summary).toBeNull();
    },
  );

  it('rejects duplicate summaries rather than selecting one', () => {
    const value = JSON.stringify(report());
    const result = observe(`${value}\n${value}`);
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.reportStatus).toBe('malformed');
    expect(result.diagnostic.total).toBeNull();
  });

  it('does not treat truncated over-budget output as a complete report', () => {
    const result = observe(`${JSON.stringify(report())}\n${'x'.repeat(64 * 1024)}`);
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.reportStatus).toBe('output_limit');
    expect(result.diagnostic.total).toBeNull();
  });

  it('counts stderr toward the same capture budget', () => {
    const result = observe(report(), 1, 'x'.repeat(64 * 1024));
    expect(result.diagnostic.reportStatus).toBe('output_limit');
    expect(result.diagnostic.total).toBeNull();
  });

  it('rejects negative or inconsistent reporter counts', () => {
    const result = observe({ ...report(), numFailedTests: -1 });
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.reportStatus).toBe('malformed');
    expect(result.diagnostic.total).toBeNull();
  });

  it('rejects positive reporter counts that cannot describe the reported total', () => {
    const result = observe({ ...report(), numPassedTests: 1 });
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.reportStatus).toBe('malformed');
    expect(result.diagnostic.total).toBeNull();
  });

  it('keeps known-case membership unknown when assertion entries are malformed', () => {
    const value = report();
    const malformed = {
      ...value,
      testResults: [{ ...value.testResults[0], assertionResults: [null] }],
    };
    const result = observe(malformed);
    expect(result.diagnostic.knownCaseFailed).toBeNull();
    expect(result.diagnostic.firstSourceFrame).toBeNull();
  });

  it('requires exact safe diagnostic keys before writing a receipt', () => {
    const result = observe(report());
    expect(() =>
      contentFreeBasic5CiVitestDiagnostic({ ...result.diagnostic, rawMessage: privateText }),
    ).toThrow();
    expect(() =>
      contentFreeBasic5CiVitestDiagnostic({
        ...result.diagnostic,
        firstSourceFrame: { file: '/unreviewed/private.ts', line: 1, column: 2 },
      }),
    ).toThrow();
  });

  it('retains a single fixed last checkpoint alongside a failed report', () => {
    const checkpoint = {
      schemaVersion: 1,
      stage: 'family_add_durable_readback_complete',
      authenticatedNavigationCount: 3,
      applyCount: 2,
      durableReadbackCount: 2,
      freshPageReadbackCount: 1,
    };
    const result = observe(
      `BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(checkpoint)}\n${JSON.stringify(report())}`,
    );
    expect(result.validOutput).toBe(true);
    expect(result.diagnostic.checkpoint).toEqual(checkpoint);
    expect(contentFreeBasic5CiVitestDiagnostic(result.diagnostic)).toEqual(result.diagnostic);
  });

  it.each([
    { stage: `private ${privateText}` },
    { authenticatedNavigationCount: 7 },
    { applyCount: 5 },
    { durableReadbackCount: -1 },
    { freshPageReadbackCount: 1.5 },
    { rawValue: privateText },
  ])('rejects arbitrary or out-of-budget checkpoint fields', (override) => {
    const checkpoint = {
      schemaVersion: 1,
      stage: 'fixture_setup_started',
      authenticatedNavigationCount: 0,
      applyCount: 0,
      durableReadbackCount: 0,
      freshPageReadbackCount: 0,
      ...override,
    };
    const result = observe(
      `BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(checkpoint)}\n${JSON.stringify(report())}`,
    );
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.checkpoint).toBeNull();
    expect(JSON.stringify(result.diagnostic)).not.toContain(privateText);
  });

  it('does not select a last checkpoint from duplicate records', () => {
    const checkpoint = JSON.stringify({
      schemaVersion: 1,
      stage: 'fixture_setup_started',
      authenticatedNavigationCount: 0,
      applyCount: 0,
      durableReadbackCount: 0,
      freshPageReadbackCount: 0,
    });
    const result = observe(
      `BASIC5_ACCEPTANCE_CHECKPOINT ${checkpoint}\nBASIC5_ACCEPTANCE_CHECKPOINT ${checkpoint}\n${JSON.stringify(report())}`,
    );
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.checkpoint).toBeNull();
  });

  it('keeps a failed runner as HOLD while carrying its parsed diagnostic through the case wrapper', async () => {
    let thrown: unknown;
    try {
      await runBasic5CiCaseEntryStep('vitest_output_parse', 'unexpected_parse_error', () =>
        parseThroughController(report(), 1, `private stderr ${privateText}`),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Basic5CiHold);
    expect(thrown).toMatchObject({
      code: 'vitest_execution_failed_or_output_overflow',
      caseEntryDiagnostic: { stage: 'vitest_output_parse', category: 'controller_hold' },
      vitestDiagnostic: { exitCode: 1, total: 1, passed: 0, failed: 1, knownCaseFailed: true },
    });
    expect(JSON.stringify((thrown as Basic5CiHold).vitestDiagnostic)).not.toContain(privateText);
  });

  it('cannot accept a failed report even with exit zero and an evidence record', () => {
    const value = `BASIC5_ACCEPTANCE_EVIDENCE {}\n${JSON.stringify(report())}`;
    const ops = Object.assign(Object.create(RealBasic5CiOps.prototype), { repoRoot }) as {
      parseVitest(stdout: Buffer, exitCode: number, stderr: Buffer): Basic5CiCaseResult;
    };
    expect(() => ops.parseVitest(Buffer.from(value), 0, Buffer.alloc(0))).toThrow(
      'vitest_report_not_successful',
    );
  });

  it('rejects successful summary counts paired with a failed known-case detail', () => {
    const failed = report();
    const contradictory = {
      ...failed,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPassedTests: 1,
      numFailedTests: 0,
      success: true,
    };
    const result = observe(contradictory, 0);
    expect(result.validOutput).toBe(false);
    expect(result.knownCasePassed).toBe(false);
    expect(result.diagnostic.knownCaseFailed).toBe(true);
    expect(() => parseThroughController(withEvidence(contradictory), 0)).toThrow(
      'vitest_json_summary_malformed',
    );
  });

  it('rejects a successful summary that omits test results despite supplied evidence', () => {
    const passed = report({ status: 'passed' });
    const { testResults: _omitted, ...missingDetails } = passed;
    const result = observe(missingDetails, 0);
    expect(result.validOutput).toBe(false);
    expect(result.knownCasePassed).toBe(false);
    expect(result.diagnostic.knownCaseFailed).toBeNull();
    expect(() => parseThroughController(withEvidence(missingDetails), 0)).toThrow(
      'vitest_json_summary_malformed',
    );
  });

  it('requires the exact known case even when another test passed and evidence exists', () => {
    const differentCase = report({ status: 'passed', title: 'a different reviewed test' });
    const result = observe(differentCase, 0);
    expect(result.validOutput).toBe(true);
    expect(result.knownCasePassed).toBe(false);
    expect(result.diagnostic.knownCaseFailed).toBe(false);
    expect(() => parseThroughController(withEvidence(differentCase), 0)).toThrow(
      'vitest_report_not_successful',
    );
  });

  it('rejects duplicate passed instances of the exact case despite consistent counts and evidence', () => {
    const passed = report({ status: 'passed' });
    const file = passed.testResults[0];
    if (!file?.assertionResults[0]) throw new Error('Missing synthetic report assertion');
    const duplicated = {
      ...passed,
      numTotalTests: 2,
      numPassedTests: 2,
      testResults: [
        {
          ...file,
          assertionResults: [file.assertionResults[0], { ...file.assertionResults[0] }],
        },
      ],
    };
    const result = observe(duplicated, 0);
    expect(result.diagnostic).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(result.knownCasePassed).toBe(false);
    expect(() => parseThroughController(withEvidence(duplicated), 0)).toThrow(
      'vitest_report_not_successful',
    );
  });

  it('rejects a success claim with a failed suite even when the known assertion passed', () => {
    const passed = report({ status: 'passed' });
    const contradictory = {
      ...passed,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
    };
    const result = observe(contradictory, 0);
    expect(result.validOutput).toBe(false);
    expect(result.knownCasePassed).toBe(false);
    expect(() => parseThroughController(withEvidence(contradictory), 0)).toThrow(
      'vitest_json_summary_malformed',
    );
  });

  it('rejects an unknown file status even when the known assertion and summary passed', () => {
    const passed = report({ status: 'passed' });
    const file = passed.testResults[0];
    if (!file) throw new Error('Missing synthetic file result');
    const malformed = {
      ...passed,
      testResults: [{ ...file, status: 'unrecognized' }],
    };
    const result = observe(malformed, 0);
    expect(result.validOutput).toBe(false);
    expect(result.knownCasePassed).toBe(false);
    expect(() => parseThroughController(withEvidence(malformed), 0)).toThrow(
      'vitest_json_summary_malformed',
    );
  });

  it('requires the single suite of the fixed reviewed fixture for a success claim', () => {
    const expanded = {
      ...report({ status: 'passed' }),
      numTotalTestSuites: 99,
      numPassedTestSuites: 99,
    };
    const observed = observe(expanded, 0);
    expect(observed.validOutput).toBe(false);
    expect(observed.knownCasePassed).toBe(false);
    expect(() => parseThroughController(withEvidence(expanded), 0)).toThrow(
      'vitest_json_summary_malformed',
    );
  });

  it('parses the genuine known-case passed report with evidence through the real controller', () => {
    const passed = report({ status: 'passed' });
    const observation = observe(passed, 0);
    expect(observation.validOutput).toBe(true);
    expect(observation.knownCasePassed).toBe(true);
    expect(observation.diagnostic.knownCaseFailed).toBe(false);
    expect(parseThroughController(withEvidence(passed), 0)).toEqual({
      exitCode: 0,
      total: 1,
      passed: 1,
      skipped: 0,
      failed: 0,
      evidence: {},
    });
  });

  it.each(['fixture_prepared', 'case_complete'])(
    'accepts the synchronized fixed checkpoint stage %s',
    (stage) => {
      const checkpoint = {
        schemaVersion: 1,
        stage,
        authenticatedNavigationCount: stage === 'case_complete' ? 6 : 0,
        applyCount: stage === 'case_complete' ? 4 : 0,
        durableReadbackCount: stage === 'case_complete' ? 4 : 0,
        freshPageReadbackCount: stage === 'case_complete' ? 4 : 0,
      };
      const result = observe(
        `BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(checkpoint)}\n${JSON.stringify(report())}`,
      );
      expect(result.validOutput).toBe(true);
      expect(result.diagnostic.checkpoint).toEqual(checkpoint);
      expect(contentFreeBasic5CiVitestDiagnostic(result.diagnostic)).toEqual(result.diagnostic);
    },
  );

  it('keeps a signalled or otherwise unavailable runner exit status null', () => {
    const result = observe(report(), null);
    expect(result.diagnostic.exitCode).toBeNull();
    expect(result.diagnostic).toMatchObject({ reportStatus: 'parsed', total: 1, failed: 1 });
    expect(contentFreeBasic5CiVitestDiagnostic(result.diagnostic).exitCode).toBeNull();
  });

  it('records capture-limit byte metadata without inventing report counts or a signal exit code', () => {
    const diagnostic = basic5CiVitestCaptureLimit(null, 65_540, 4_096);
    expect(diagnostic).toMatchObject({
      exitCode: null,
      stdoutBytes: 65_540,
      stderrBytes: 4_096,
      reportStatus: 'output_limit',
      total: null,
      passed: null,
      failed: null,
      pending: null,
      todo: null,
      knownCaseFailed: null,
      firstSourceFrame: null,
      checkpoint: null,
    });
    expect(contentFreeBasic5CiVitestDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(() => contentFreeBasic5CiVitestDiagnostic({ ...diagnostic, total: 0 })).toThrow();
  });

  it('rejects objects coercible to allowed diagnostic strings', () => {
    const diagnostic = observe(report()).diagnostic;
    expect(() =>
      contentFreeBasic5CiVitestDiagnostic({
        ...diagnostic,
        reportStatus: { toString: () => 'parsed' },
      }),
    ).toThrow();
    expect(() =>
      contentFreeBasic5CiVitestDiagnostic({
        ...diagnostic,
        errorCategory: { toString: () => 'assertion_failure' },
      }),
    ).toThrow();
    expect(() =>
      contentFreeBasic5CiVitestDiagnostic({
        ...diagnostic,
        firstSourceFrame: {
          file: { toString: () => fixture },
          line: 700,
          column: 12,
        },
      }),
    ).toThrow();
  });
});
