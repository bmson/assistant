import { describe, expect, it } from 'vitest';
import {
  BASIC5_AUTHENTICATED_NAVIGATION_COUNT,
  createBasic5BrowserRequestBudget,
  routeBasic5BrowserRequest,
} from './basic5-browser-acceptance-support.js';
import {
  type Basic5CiCaseResult,
  Basic5CiHold,
  RealBasic5CiOps,
  runBasic5CiCaseEntryStep,
} from './basic5-ci-acceptance.js';
import {
  basic5CiVitestCaptureLimit,
  classifyBasic5AnonymousLocation,
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

  it('projects only observed page status and a fixed destination class without retaining URLs', () => {
    const base = 'http://127.0.0.1:3107';
    expect(classifyBasic5AnonymousLocation(undefined, base)).toBe('absent');
    expect(classifyBasic5AnonymousLocation('/api/auth/signin', base)).toBe('same_origin_signin');
    expect(classifyBasic5AnonymousLocation('/api/auth/signin?private=secret', base)).toBe(
      'other_same_origin',
    );
    expect(classifyBasic5AnonymousLocation('https://outside.test/private', base)).toBe(
      'off_origin',
    );
    expect(
      classifyBasic5AnonymousLocation('http://user:secret@127.0.0.1:3107/api/auth/signin', base),
    ).toBe('invalid');
    const checkpoint = {
      schemaVersion: 1,
      stage: 'browser_launched',
      authenticatedNavigationCount: 0,
      applyCount: 0,
      durableReadbackCount: 0,
      freshPageReadbackCount: 0,
      anonymousPageStatus: 200,
      anonymousLocationClass: 'absent',
    };
    const output = (value: unknown) =>
      observe(`BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(value)}\n${JSON.stringify(report())}`);
    const good = output(checkpoint);
    expect(good.diagnostic.checkpoint).toEqual(checkpoint);
    expect(contentFreeBasic5CiVitestDiagnostic(good.diagnostic)).toEqual(good.diagnostic);
    for (const patch of [
      { anonymousPageStatus: 0 },
      { anonymousPageStatus: 600 },
      { anonymousPageStatus: '200' },
      { anonymousLocationClass: 'https://private.test?token=secret' },
      { extraBody: privateText },
    ]) {
      const bad = output({ ...checkpoint, ...patch });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain('secret');
    }
    const { anonymousLocationClass: _removed, ...missingClass } = checkpoint;
    expect(output(missingClass).validOutput).toBe(false);
  });

  it('retains only closed save phase metadata and distinguishes unknown POST counts', () => {
    const saveObservation = {
      operation: 'add_family_relationship',
      phase: 'request_seen',
      totalMatchingPostCount: 2,
      commandMatched: true,
      httpStatus: null,
      nativeValid: true,
      invalidControlPresent: false,
      alertPresent: false,
      saveEnabled: true,
      pageClosed: false,
      errorStage: 'wait',
      errorCategory: 'timeout',
    };
    const checkpoint = {
      schemaVersion: 1,
      stage: 'identity_fresh_page_readback_complete',
      authenticatedNavigationCount: 2,
      applyCount: 1,
      durableReadbackCount: 1,
      freshPageReadbackCount: 1,
      saveObservation,
    };
    const output = (value: unknown) =>
      observe(`BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(value)}\n${JSON.stringify(report())}`);
    const good = output(checkpoint);
    expect(good.diagnostic.checkpoint?.saveObservation).toEqual(saveObservation);
    expect(contentFreeBasic5CiVitestDiagnostic(good.diagnostic)).toEqual(good.diagnostic);
    const unknown = output({
      ...checkpoint,
      saveObservation: { ...saveObservation, totalMatchingPostCount: null, nativeValid: null },
    });
    expect(unknown.diagnostic.checkpoint?.saveObservation?.totalMatchingPostCount).toBeNull();
    for (const patch of [
      { operation: privateText },
      { phase: privateText },
      { totalMatchingPostCount: 65 },
      { httpStatus: 600 },
      { httpStatus: '200' },
      { nativeValid: privateText },
      { pageClosed: null },
      { errorStage: privateText },
      { errorCategory: privateText },
      { rawBody: privateText },
    ]) {
      const bad = output({ ...checkpoint, saveObservation: { ...saveObservation, ...patch } });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain(privateText);
    }
  });

  it('retains existing browser-budget and local-fixture counters without inferring server outcome', () => {
    const fixtureCounters = {
      observedAt: 'save_settled',
      browserHttpRequests: 120,
      browserControlHttpRequests: 65,
      browserPresentationHttpRequests: 55,
      browserBudgetExceeded: true,
      localEmbeddingReceived: 0,
      localEmbeddingFinished: 0,
    };
    const saveTransport = {
      operation: 'add_family_relationship',
      routeBlocked: true,
      requestFailedClass: 'blocked_by_client',
    };
    const checkpoint = {
      schemaVersion: 1,
      stage: 'identity_fresh_page_readback_complete',
      authenticatedNavigationCount: 2,
      applyCount: 1,
      durableReadbackCount: 1,
      freshPageReadbackCount: 1,
      fixtureCounters,
      saveTransport,
    };
    const output = (value: unknown) =>
      observe(`BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(value)}\n${JSON.stringify(report())}`);
    const good = output(checkpoint);
    expect(good.diagnostic.checkpoint?.fixtureCounters).toEqual(fixtureCounters);
    expect(good.diagnostic.checkpoint?.saveTransport).toEqual(saveTransport);
    expect(contentFreeBasic5CiVitestDiagnostic(good.diagnostic)).toEqual(good.diagnostic);
    for (const patch of [
      { browserHttpRequests: '120' },
      { browserHttpRequests: -1 },
      { browserControlHttpRequests: -1 },
      { browserPresentationHttpRequests: 1.5 },
      { browserControlHttpRequests: 1_000_001 },
      { browserPresentationHttpRequests: '55' },
      { browserControlHttpRequests: 64 },
      { browserBudgetExceeded: privateText },
      { localEmbeddingReceived: 0, localEmbeddingFinished: 1 },
      { rawUrl: privateText },
    ]) {
      const bad = output({ ...checkpoint, fixtureCounters: { ...fixtureCounters, ...patch } });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain(privateText);
    }
    const { browserPresentationHttpRequests: _missingPresentation, ...missingPresentation } =
      fixtureCounters;
    const missingBucket = output({
      ...checkpoint,
      fixtureCounters: missingPresentation,
    });
    expect(missingBucket.validOutput).toBe(false);
    expect(missingBucket.diagnostic.checkpoint).toBeNull();
    const unknownBucket = output({
      ...checkpoint,
      fixtureCounters: { ...fixtureCounters, browserControlHttpRequests: null },
    });
    expect(unknownBucket.diagnostic.checkpoint?.fixtureCounters).toMatchObject({
      browserHttpRequests: 120,
      browserControlHttpRequests: null,
      browserPresentationHttpRequests: 55,
    });
    const unknownTotal = output({
      ...checkpoint,
      fixtureCounters: { ...fixtureCounters, browserHttpRequests: null },
    });
    expect(unknownTotal.diagnostic.checkpoint?.fixtureCounters).toMatchObject({
      browserHttpRequests: null,
      browserControlHttpRequests: 65,
      browserPresentationHttpRequests: 55,
    });
    const legacy = output({
      ...checkpoint,
      fixtureCounters: {
        observedAt: 'checkpoint',
        browserHttpRequests: 85,
        browserBudgetExceeded: true,
        localEmbeddingReceived: 0,
        localEmbeddingFinished: 0,
      },
    });
    expect(legacy.validOutput).toBe(true);
    expect(legacy.diagnostic.checkpoint?.fixtureCounters).toMatchObject({
      browserHttpRequests: 85,
      browserControlHttpRequests: null,
      browserPresentationHttpRequests: null,
    });
    for (const patch of [
      { operation: privateText },
      { routeBlocked: privateText },
      { requestFailedClass: privateText },
      { errorText: privateText },
    ]) {
      const bad = output({ ...checkpoint, saveTransport: { ...saveTransport, ...patch } });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain(privateText);
    }
    const unknown = output({
      ...checkpoint,
      fixtureCounters: {
        ...fixtureCounters,
        browserHttpRequests: null,
        localEmbeddingReceived: null,
        localEmbeddingFinished: null,
      },
      saveTransport: { ...saveTransport, routeBlocked: null, requestFailedClass: null },
    });
    expect(unknown.diagnostic.checkpoint?.fixtureCounters?.localEmbeddingReceived).toBeNull();
    expect(unknown.diagnostic.checkpoint?.saveTransport?.routeBlocked).toBeNull();
  });

  it('accepts the 16-stage, 17-bucket candidate frame and preserves nullable checkpoint forms', () => {
    const blank = {
      document: 0,
      next_static_asset: 0,
      public_asset: 0,
      rsc_or_prefetch: 0,
      other: 0,
    };
    const lastNavigation = { ...blank, document: 1, next_static_asset: 1 };
    const diagnostics = {
      bucketMostRecentNavigation: BASIC5_AUTHENTICATED_NAVIGATION_COUNT,
      byNavigation: Array.from({ length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1 }, (_, index) =>
        index === BASIC5_AUTHENTICATED_NAVIGATION_COUNT ? lastNavigation : blank,
      ),
      totals: { ...lastNavigation },
    };
    const checkpoint = {
      schemaVersion: 1,
      stage: 'note_correction_fresh_page_readback_complete',
      authenticatedNavigationCount: BASIC5_AUTHENTICATED_NAVIGATION_COUNT,
      applyCount: 4,
      durableReadbackCount: 4,
      freshPageReadbackCount: 4,
      fixtureCounters: {
        observedAt: 'checkpoint',
        browserHttpRequests: 2,
        browserControlHttpRequests: 0,
        browserPresentationHttpRequests: 2,
        browserPresentationDiagnostics: diagnostics,
        browserBudgetExceeded: false,
        localEmbeddingReceived: 0,
        localEmbeddingFinished: 0,
      },
    };
    const output = (value: unknown) =>
      observe(`BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(value)}\n${JSON.stringify(report())}`);
    const valid = output(checkpoint);
    expect(valid.validOutput).toBe(true);
    expect(valid.diagnostic.checkpoint?.fixtureCounters).toMatchObject({
      browserHttpRequests: 2,
      browserControlHttpRequests: 0,
      browserPresentationHttpRequests: 2,
      browserPresentationDiagnostics: diagnostics,
    });

    const sevenNavigationDiagnostics = {
      ...diagnostics,
      bucketMostRecentNavigation: 7,
      byNavigation: Array.from({ length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1 }, (_, index) =>
        index === 7 ? lastNavigation : blank,
      ),
    };
    const sevenNavigation = output({
      ...checkpoint,
      stage: 'authenticated_navigation_complete',
      authenticatedNavigationCount: 7,
      applyCount: 1,
      durableReadbackCount: 1,
      freshPageReadbackCount: 1,
      fixtureCounters: {
        ...checkpoint.fixtureCounters,
        browserPresentationDiagnostics: sevenNavigationDiagnostics,
      },
    });
    expect(sevenNavigation.validOutput).toBe(true);
    expect(sevenNavigation.diagnostic.checkpoint?.authenticatedNavigationCount).toBe(7);
    expect(
      sevenNavigation.diagnostic.checkpoint?.fixtureCounters?.browserPresentationDiagnostics
        ?.byNavigation,
    ).toHaveLength(BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1);

    const unknownDiagnostics = output({
      ...checkpoint,
      fixtureCounters: { ...checkpoint.fixtureCounters, browserPresentationDiagnostics: null },
    });
    expect(unknownDiagnostics.validOutput).toBe(true);
    expect(
      unknownDiagnostics.diagnostic.checkpoint?.fixtureCounters?.browserPresentationDiagnostics,
    ).toBeNull();

    for (const invalidDiagnostics of [
      { ...diagnostics, rawUrl: privateText },
      {
        ...diagnostics,
        totals: { ...diagnostics.totals, document: '1' },
      },
      {
        ...diagnostics,
        totals: { ...diagnostics.totals, document: 1_000_001 },
      },
      {
        ...diagnostics,
        totals: { ...diagnostics.totals, unexpected_class: 0 },
      },
      { ...diagnostics, bucketMostRecentNavigation: 1.5 },
      { ...diagnostics, bucketMostRecentNavigation: BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1 },
      {
        ...diagnostics,
        bucketMostRecentNavigation: 6,
        byNavigation: diagnostics.byNavigation.slice(0, 7),
      },
      { ...diagnostics, byNavigation: diagnostics.byNavigation.slice(1) },
      { ...diagnostics, byNavigation: undefined },
      { ...diagnostics, byNavigation: [...diagnostics.byNavigation, { ...blank }] },
      {
        ...diagnostics,
        totals: { ...diagnostics.totals, document: 2 },
      },
      {
        ...diagnostics,
        totals: { ...diagnostics.totals, next_static_asset: -1 },
      },
      {
        ...diagnostics,
        byNavigation: [
          { ...lastNavigation, document: 1.5 },
          ...Array.from({ length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT }, () => ({ ...blank })),
        ],
      },
    ]) {
      const bad = output({
        ...checkpoint,
        fixtureCounters: {
          ...checkpoint.fixtureCounters,
          browserPresentationDiagnostics: invalidDiagnostics,
        },
      });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain(privateText);
    }

    for (const countKey of ['browserControlHttpRequests', 'browserPresentationHttpRequests']) {
      for (const invalidCount of [-1, 1.5, '2']) {
        const bad = output({
          ...checkpoint,
          fixtureCounters: {
            ...checkpoint.fixtureCounters,
            [countKey]: invalidCount,
            browserPresentationDiagnostics: null,
          },
        });
        expect(bad.validOutput).toBe(false);
        expect(bad.diagnostic.checkpoint).toBeNull();
      }
    }
  });

  it('retains sticky over-limit route attempts in the failure checkpoint buckets', async () => {
    const baseUrl = 'http://127.0.0.1:3107';
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const routeAttempt = async (pathname: string, method: string, expected: boolean) => {
      const events: string[] = [];
      const route = {
        request: () => ({ url: () => `${baseUrl}${pathname}`, method: () => method }),
        continue: async () => {
          events.push('continue');
        },
        abort: async (code: 'blockedbyclient') => {
          events.push(`abort:${code}`);
        },
      };
      let observedAllowed: boolean | undefined;
      await routeBasic5BrowserRequest(budget, route, (allowed) => {
        observedAllowed = allowed;
      });
      expect(observedAllowed).toBe(expected);
      expect(events).toEqual([expected ? 'continue' : 'abort:blockedbyclient']);
    };

    for (let index = 0; index < 64; index++)
      await routeAttempt('/api/profile/knowledge/family', 'POST', true);
    await routeAttempt('/api/profile/knowledge/family', 'POST', false);
    for (let index = 0; index < 55; index++) await routeAttempt('/people/person', 'GET', false);
    await routeAttempt('/api/profile/knowledge/family', 'POST', false);

    const snapshot = budget.snapshot();
    expect(snapshot).toEqual({
      browserHttpRequests: 121,
      browserControlHttpRequests: 66,
      browserPresentationHttpRequests: 55,
      browserBudgetExceeded: true,
      browserPresentationDiagnostics: null,
    });
    const checkpoint = {
      schemaVersion: 1,
      stage: 'identity_apply_complete',
      authenticatedNavigationCount: 2,
      applyCount: 0,
      durableReadbackCount: 0,
      freshPageReadbackCount: 0,
      fixtureCounters: {
        observedAt: 'save_settled',
        ...snapshot,
        localEmbeddingReceived: 0,
        localEmbeddingFinished: 0,
      },
    };
    const parsed = observe(
      `BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(checkpoint)}\n${JSON.stringify(report())}`,
    );
    expect(parsed.validOutput).toBe(true);
    expect(parsed.diagnostic.checkpoint?.fixtureCounters).toEqual(checkpoint.fixtureCounters);
    expect(contentFreeBasic5CiVitestDiagnostic(parsed.diagnostic)).toEqual(parsed.diagnostic);
  });

  it('keeps reply-boundary diagnostics to closed membership and type flags only', () => {
    const reply = {
      step: 'response_json',
      contentTypeClass: 'html',
      decoderCallable: true,
      jsonReadCompleted: false,
      topLevelObject: null,
      wireKeysAllowed: null,
      receiptKeysPresent: null,
      versionTypeNumber: null,
      versionOne: null,
      wireTypesValid: null,
      decoderAccepted: null,
    };
    const saveObservation = {
      operation: 'update_person_identity',
      phase: 'parse',
      totalMatchingPostCount: 1,
      commandMatched: true,
      httpStatus: 200,
      nativeValid: null,
      invalidControlPresent: null,
      alertPresent: null,
      saveEnabled: null,
      pageClosed: false,
      errorStage: 'parse',
      errorCategory: 'other',
      reply,
    };
    const checkpoint = {
      schemaVersion: 1,
      stage: 'authenticated_navigation_complete',
      authenticatedNavigationCount: 1,
      applyCount: 0,
      durableReadbackCount: 0,
      freshPageReadbackCount: 0,
      saveObservation,
    };
    const output = (value: unknown) =>
      observe(`BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(value)}\n${JSON.stringify(report())}`);
    const good = output(checkpoint);
    expect(good.diagnostic.checkpoint?.saveObservation?.reply).toEqual(reply);
    expect(contentFreeBasic5CiVitestDiagnostic(good.diagnostic)).toEqual(good.diagnostic);
    for (const patch of [
      { step: privateText },
      { contentTypeClass: privateText },
      { decoderCallable: privateText },
      { topLevelObject: privateText },
      { rawBody: privateText },
      { decoderAccepted: true },
      { jsonReadCompleted: true },
    ]) {
      const bad = output({
        ...checkpoint,
        saveObservation: { ...saveObservation, reply: { ...reply, ...patch } },
      });
      expect(bad.validOutput).toBe(false);
      expect(bad.diagnostic.checkpoint).toBeNull();
      expect(JSON.stringify(bad.diagnostic)).not.toContain(privateText);
    }
    const unknown = output({
      ...checkpoint,
      saveObservation: { ...saveObservation, reply: { ...reply, contentTypeClass: 'unknown' } },
    });
    expect(unknown.diagnostic.checkpoint?.saveObservation?.reply?.contentTypeClass).toBe('unknown');
  });

  it('permits only the reviewed save helper as an additional first source frame', () => {
    const result = observe(
      report({
        stack: `Error: private message\n    at /reviewed/assistant/scripts/basic5-browser-save-observation.ts:50:7`,
      }),
    );
    expect(result.diagnostic.firstSourceFrame).toEqual({
      file: 'scripts/basic5-browser-save-observation.ts',
      line: 50,
      column: 7,
    });
    expect(contentFreeBasic5CiVitestDiagnostic(result.diagnostic)).toEqual(result.diagnostic);
    expect(JSON.stringify(result.diagnostic)).not.toContain('private message');
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

  it('keeps a malformed legacy navigation frame on the controller hard-failure path', () => {
    const blank = {
      document: 0,
      next_static_asset: 0,
      public_asset: 0,
      rsc_or_prefetch: 0,
      other: 0,
    };
    const oldFrameCheckpoint = {
      schemaVersion: 1,
      stage: 'authenticated_navigation_complete',
      authenticatedNavigationCount: 7,
      applyCount: 1,
      durableReadbackCount: 1,
      freshPageReadbackCount: 1,
      fixtureCounters: {
        observedAt: 'checkpoint',
        browserHttpRequests: 1,
        browserControlHttpRequests: 0,
        browserPresentationHttpRequests: 1,
        browserPresentationDiagnostics: {
          bucketMostRecentNavigation: 6,
          byNavigation: Array.from({ length: 7 }, (_, index) =>
            index === 6 ? { ...blank, document: 1 } : { ...blank },
          ),
          totals: { ...blank, document: 1 },
        },
        browserBudgetExceeded: false,
        localEmbeddingReceived: 0,
        localEmbeddingFinished: 0,
      },
    };
    const stdout = `BASIC5_ACCEPTANCE_CHECKPOINT ${JSON.stringify(oldFrameCheckpoint)}\nBASIC5_ACCEPTANCE_EVIDENCE {}\n${JSON.stringify(report({ status: 'passed' }))}`;
    const result = observe(stdout, 0);
    expect(result.validOutput).toBe(false);
    expect(result.diagnostic.checkpoint).toBeNull();
    expect(() => parseThroughController(stdout, 0)).toThrow('vitest_json_summary_malformed');
  });

  it.each([
    { stage: `private ${privateText}` },
    { stage: 'unknown_checkpoint_stage' },
    { authenticatedNavigationCount: BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1 },
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
