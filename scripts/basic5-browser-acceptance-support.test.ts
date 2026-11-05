import { createRequire } from 'node:module';
import {
  type OwnerEditorOperationRecord,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorScopeDigest,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  assertBasic5AnonymousPageResponse,
  assertBasic5ReceiptSequence,
  BASIC5_AUTH_COOKIE_NAME,
  BASIC5_AUTHENTICATED_NAVIGATION_COUNT,
  BASIC5_BROWSER_ACTIONS,
  BASIC5_BROWSER_CONTROL_REQUEST_LIMIT,
  BASIC5_BROWSER_PRESENTATION_REQUEST_LIMIT,
  BASIC5_BROWSER_TOTAL_REQUEST_LIMIT,
  BASIC5_EMBEDDING_DIMENSIONS,
  BASIC5_LOGICAL_NAVIGATION_STAGES,
  BASIC5_READINESS_ATTEMPT_LIMIT,
  BASIC5_SAVED_STATUS_PATTERN,
  type Basic5StoredUserFlowReceiptExpectation,
  basic5BrowserLaunchOptions,
  basic5EmbeddingResponse,
  basic5IsolatedWebEnvironment,
  boundedBasic5ObservedCount,
  classifyBasic5RequestFailure,
  createBasic5AuthCookie,
  createBasic5BrowserRequestBudget,
  decodeBasic5AuthCookie,
  nextBasic5ReadinessAttempt,
  qualifyBasic5StoredUserFlowReceipt,
  routeBasic5BrowserRequest,
} from './basic5-browser-acceptance-support.js';

const require = createRequire(import.meta.url);
const nextRedirect =
  require('../apps/web/node_modules/next/dist/client/components/redirect.js') as {
    getRedirectError: (url: string, type: 'push' | 'replace') => Error & { digest: string };
  };
const nextServerInsertedHtml =
  require('../apps/web/node_modules/next/dist/server/app-render/make-get-server-inserted-html.js') as {
    makeGetServerInsertedHTML: (input: {
      polyfills: never[];
      renderServerInsertedHTML: () => never[];
      serverCapturedErrors: (Error & { digest: string })[];
      tracingMetadata: undefined;
      basePath: string;
    }) => () => Promise<string>;
  };
const nextStreamHelper =
  require('../apps/web/node_modules/next/dist/server/stream-utils/node-web-streams-helper.js') as {
    createHeadInsertionTransformStream: (
      insert: () => Promise<string>,
    ) => TransformStream<Uint8Array, Uint8Array>;
  };

const secret = 'basic5-offline-auth-cookie-secret-32-bytes';
const authBaseUrl = 'http://127.0.0.1:3107';
const defaultProtectedMarkers = ['Alex Rivera', 'synthetic note body'];
const anonymousHtmlContentType = 'text/html; charset=utf-8';

describe('BASIC5 canonical stored receipt plus observed saved UI contract', () => {
  it.each([
    'Saved.',
    'Saved. Some derived details still need to refresh.',
    'Saved. Related information may still show older details.',
  ])('accepts only an exact permitted saved status: %s', (message) => {
    expect(BASIC5_SAVED_STATUS_PATTERN.test(message)).toBe(true);
  });
  it.each([
    'Already saved.',
    'Saving…',
    'The result could not be confirmed. Check its result.',
    'Saved. Check its result.',
    'Saved. Some derived details still need to refresh. Extra text',
    'Prefix Saved.',
    'saved.',
    'Saved',
    'Saved!',
    ' Saved.',
    'Saved. ',
    'Saved.\n',
    'Saved.\r\n',
    'Changed saved details. Review before saving again.',
    'Check the highlighted fields.',
  ])('rejects a status outside the exact saved-status pattern: %s', (message) => {
    expect(BASIC5_SAVED_STATUS_PATTERN.test(message)).toBe(false);
  });
  const differentId = '99999999-9999-4999-8999-999999999999';
  function stored(
    command: Basic5StoredUserFlowReceiptExpectation['command'] = 'update_person_identity',
  ) {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const scope = {
      ownerId: '11111111-1111-4111-8111-111111111111',
      epoch: '22222222-2222-4222-8222-222222222222',
      privacyGeneration: null,
      command,
      operationId: '33333333-3333-4333-8333-333333333333',
      targetId: '44444444-4444-4444-8444-444444444444',
      sessionDigest: 'a'.repeat(64),
      nonce: '55555555-5555-4555-8555-555555555555',
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 600_000,
    };
    const memoryId = '66666666-6666-4666-8666-666666666666';
    const row: OwnerEditorOperationRecord = {
      id: ownerEditorOperationId(scope),
      ownerId: scope.ownerId,
      epoch: scope.epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      operationId: scope.operationId,
      requestHash: 'b'.repeat(64),
      scopeDigest: ownerEditorScopeDigest(scope),
      command,
      protocolVersion: 1,
      formIssuedAt: now,
      formExpiresAt: new Date(now.getTime() + 600_000),
      claimToken: null,
      claimExpiresAt: null,
      status: 'committed',
      statusVersion: 2,
      result: {
        outcome: 'saved',
        ids:
          command === 'update_person_identity'
            ? { contactId: scope.targetId }
            : command === 'correct_owner_memory'
              ? { memoryId }
              : {
                  relationId: '77777777-7777-4777-8777-777777777777',
                  memoryId,
                  assertionId: '88888888-8888-4888-8888-888888888888',
                  ...(command === 'correct_owner_family_relationship'
                    ? { previousRelationId: scope.targetId }
                    : {}),
                },
        revision: 'c'.repeat(64),
      },
      createdAt: now,
      updatedAt: now,
    };
    const expected: Basic5StoredUserFlowReceiptExpectation = {
      ownerId: row.ownerId,
      epoch: row.epoch,
      privacyGenerationDigest: row.privacyGenerationDigest,
      command,
      operationId: row.operationId,
      requestHash: row.requestHash,
    };
    return { row, expected };
  }

  it.each(BASIC5_BROWSER_ACTIONS)(
    '%s returns the actual persisted codec receipt only with saved UI proof',
    (command) => {
      const { row, expected } = stored(command);
      const parsed = parseOwnerEditorOperationRecord(row);
      const canonicalReceipt = ownerEditorReceipt(parsed);
      const before = JSON.stringify(row);

      expect(qualifyBasic5StoredUserFlowReceipt(row, expected, true)).toEqual(canonicalReceipt);
      expect(JSON.stringify(row)).toBe(before);
      expect(() => qualifyBasic5StoredUserFlowReceipt(row, expected, false)).toThrow(
        'exact saved-user-flow contract',
      );
    },
  );

  it('accepts the real refresh-pending saved projection without adding stored-row fields', () => {
    const { row, expected } = stored();
    if (row.result?.outcome !== 'saved') throw Error('Invalid saved fixture');
    row.result.refreshPending = true;
    const receipt = qualifyBasic5StoredUserFlowReceipt(row, expected, true);
    expect(receipt).toEqual(ownerEditorReceipt(parseOwnerEditorOperationRecord(row)));
    expect(receipt).toMatchObject({ outcome: 'saved', refreshPending: true });
    expect(receipt).not.toHaveProperty('ownerId');
    expect(receipt).not.toHaveProperty('epoch');
    expect(receipt).not.toHaveProperty('scopeDigest');
  });

  it.each([1, 2])(
    'requires a positive codec/decoder status version and accepts %i',
    (statusVersion) => {
      const { row, expected } = stored();
      row.statusVersion = statusVersion;
      expect(qualifyBasic5StoredUserFlowReceipt(row, expected, true)).toMatchObject({
        statusVersion,
      });
    },
  );

  it('rejects another command even when both its stored codec and saved reply are valid', () => {
    const { expected } = stored('update_person_identity');
    const { row } = stored('add_family_relationship');
    expect(() => parseOwnerEditorOperationRecord(row)).not.toThrow();
    expect(ownerEditorReceipt(parseOwnerEditorOperationRecord(row))).toMatchObject({
      command: 'add_family_relationship',
      outcome: 'saved',
    });
    expect(() => qualifyBasic5StoredUserFlowReceipt(row, expected, true)).toThrow(
      'exact saved-user-flow contract',
    );
  });

  it.each([
    ['owner', { ownerId: differentId }],
    ['epoch', { epoch: differentId }],
    ['privacy', { privacyGenerationDigest: 'd'.repeat(64) }],
    ['command', { command: 'correct_owner_memory' }],
    ['operation', { operationId: differentId }],
    ['request hash', { requestHash: 'd'.repeat(64) }],
    ['protocol', { protocolVersion: 2 }],
    ['status', { status: 'terminal_rejected' }],
    ['status version zero', { statusVersion: 0 }],
    ['status version fractional', { statusVersion: 1.5 }],
    ['malformed row identity', { id: 'not-a-hash' }],
    ['malformed date', { createdAt: '2026-11-01T12:00:00.000Z' }],
    ['unexpected row fields', { privatePayload: 'private fixture value' }],
    ['missing result', { result: null }],
  ] as const)('rejects a mismatched or malformed %s', (_label, override) => {
    const { row, expected } = stored();
    expect(() =>
      qualifyBasic5StoredUserFlowReceipt({ ...row, ...override }, expected, true),
    ).toThrow('exact saved-user-flow contract');
  });

  it.each([
    { outcome: 'unchanged', ids: { contactId: differentId }, revision: 'c'.repeat(64) },
    { outcome: 'invalid', fieldErrors: { name: 'private fixture value' } },
    { outcome: 'conflict', reason: 'changed' },
    { outcome: 'unavailable', reason: 'not_ready' },
    { outcome: 'not_applied', reason: 'preparation_failed' },
    { authority: 'unresolved', outcome: 'outcome_unknown', reason: 'preparing' },
    { outcome: 'saved', ids: {}, revision: 'c'.repeat(64) },
    { outcome: 'saved', ids: { contactId: 'not-a-uuid' }, revision: 'c'.repeat(64) },
    { outcome: 'saved', ids: { contactId: differentId }, revision: 'not-a-hash' },
  ])('rejects non-saved or malformed stored terminal outcomes %#', (result) => {
    const { row, expected } = stored();
    const status =
      result.outcome === 'not_applied'
        ? 'abandoned'
        : ['invalid', 'conflict', 'unavailable'].includes(result.outcome)
          ? 'terminal_rejected'
          : 'committed';
    expect(() =>
      qualifyBasic5StoredUserFlowReceipt({ ...row, status, result }, expected, true),
    ).toThrow('exact saved-user-flow contract');
  });

  it('rejects a legitimate preparing record rather than treating it as a saved receipt', () => {
    const { row, expected } = stored();
    expect(() =>
      qualifyBasic5StoredUserFlowReceipt(
        {
          ...row,
          status: 'preparing',
          result: null,
          claimToken: differentId,
          claimExpiresAt: new Date('2026-11-01T12:01:00.000Z'),
        },
        expected,
        true,
      ),
    ).toThrow('exact saved-user-flow contract');
  });

  it.each([
    ['update_person_identity', { memoryId: differentId }],
    ['add_family_relationship', { relationId: differentId, memoryId: differentId }],
    ['correct_owner_memory', { memoryId: differentId, contactId: differentId }],
  ] as const)(
    'uses the real strict reply decoder for command-specific saved IDs: %s',
    (command, ids) => {
      const { row, expected } = stored(command);
      expect(() =>
        qualifyBasic5StoredUserFlowReceipt(
          {
            ...row,
            result: { outcome: 'saved', ids, revision: 'c'.repeat(64) },
          },
          expected,
          true,
        ),
      ).toThrow('exact saved-user-flow contract');
    },
  );

  it('does not accept a truthy unknown UI observation even for a committed saved row', () => {
    const { row, expected } = stored();
    expect(() =>
      qualifyBasic5StoredUserFlowReceipt(row, expected, 'Saved.' as unknown as boolean),
    ).toThrow('exact saved-user-flow contract');
    expect(() => qualifyBasic5StoredUserFlowReceipt(undefined, expected, true)).toThrow(
      'exact saved-user-flow contract',
    );
  });
});

describe('task-specific BASIC5 control and presentation request budgets', () => {
  const baseUrl = 'http://127.0.0.1:3107';
  const budgetCounts = (
    snapshot: ReturnType<ReturnType<typeof createBasic5BrowserRequestBudget>['snapshot']>,
  ) => ({
    browserHttpRequests: snapshot.browserHttpRequests,
    browserControlHttpRequests: snapshot.browserControlHttpRequests,
    browserPresentationHttpRequests: snapshot.browserPresentationHttpRequests,
    browserBudgetExceeded: snapshot.browserBudgetExceeded,
  });
  const checkTotals = (budget: ReturnType<typeof createBasic5BrowserRequestBudget>) => {
    const snapshot = budget.snapshot();
    expect(snapshot.browserHttpRequests).toBe(
      snapshot.browserControlHttpRequests + snapshot.browserPresentationHttpRequests,
    );
    return budgetCounts(snapshot);
  };
  function fakeRoute(url: string, method: string, events: string[], resourceType?: string) {
    return {
      request: () => ({
        url: () => url,
        method: () => method,
        resourceType: () => resourceType ?? 'fetch',
      }),
      continue: vi.fn(async () => {
        events.push('continue');
      }),
      abort: vi.fn(async (errorCode: 'blockedbyclient') => {
        events.push(`abort:${errorCode}`);
      }),
    };
  }

  it('pins separate control, presentation, and total caps', () => {
    expect(BASIC5_BROWSER_CONTROL_REQUEST_LIMIT).toBe(64);
    expect(BASIC5_BROWSER_PRESENTATION_REQUEST_LIMIT).toBe(256);
    expect(BASIC5_BROWSER_TOTAL_REQUEST_LIMIT).toBe(320);
  });

  it('pins the 16 semantic navigation stages for the four-save journey', () => {
    expect(BASIC5_AUTHENTICATED_NAVIGATION_COUNT).toBe(16);
    expect(BASIC5_LOGICAL_NAVIGATION_STAGES).toEqual([
      'identity_people_search',
      'identity_open_person',
      'identity_leave_to_people_search',
      'identity_reopen_person',
      'identity_reload_person',
      'family_add_leave_to_connections_search',
      'family_add_reopen_person',
      'family_add_reload_person',
      'family_correction_leave_to_connections_search',
      'family_correction_reopen_person',
      'family_correction_reload_person',
      'note_correction_library_search',
      'note_correction_open_note',
      'note_correction_leave_to_library_search',
      'note_correction_reopen_note',
      'note_correction_reload_note',
    ]);
  });

  it('routes a synthetic 16-navigation, RSC/prefetch, public/asset, four-command sequence through the actual adapter', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    // This is a synthetic contract replay, not a reconstruction of a retained
    // run. Presentation GETs can read application data and establish no auth proof.
    expect(budget.observe(`${baseUrl}/people/person`, 'GET', true)).toBe(true);
    const requests: Array<[string, string]> = [
      ...Array.from(
        { length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT },
        () => ['/people/person', 'GET'] as [string, string],
      ),
      ...Array.from(
        { length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT },
        (_, i) => [`/people/person?_rsc=synthetic-${i}`, 'GET'] as [string, string],
      ),
      ...Array.from(
        { length: 70 },
        (_, i) =>
          [
            i % 2 === 0 ? `/_next/static/chunks/synthetic-${i}.js` : `/public/synthetic-${i}.svg`,
            'GET',
          ] as [string, string],
      ),
      ['/api/people/editor', 'POST'],
      ['/api/profile/knowledge/family', 'POST'],
      ['/api/profile/knowledge/family', 'POST'],
      ['/api/profile/knowledge/memory', 'POST'],
    ];
    let oldCombinedWouldBlock = false;
    for (const [pathname, method] of requests) {
      const events: string[] = [];
      const route = fakeRoute(`${baseUrl}${pathname}`, method, events);
      await routeBasic5BrowserRequest(budget, route, (allowed, snapshot) => {
        events.push('decision');
        expect(allowed).toBe(true);
        expect(budgetCounts(snapshot)).toEqual(budgetCounts(budget.snapshot()));
        oldCombinedWouldBlock ||= snapshot.browserHttpRequests > 64;
      });
      expect(events).toEqual(['decision', 'continue']);
      expect(route.continue).toHaveBeenCalledOnce();
      expect(route.abort).not.toHaveBeenCalled();
      checkTotals(budget);
    }
    expect(oldCombinedWouldBlock).toBe(true);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 107,
      browserControlHttpRequests: 5,
      browserPresentationHttpRequests: 102,
      browserBudgetExceeded: false,
    });
  });

  it('retains only closed request classes and fixed navigation buckets while counting repeated URLs', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const routeOne = async (pathname: string, resourceType: string) => {
      const route = fakeRoute(`${baseUrl}${pathname}`, 'GET', [], resourceType);
      await routeBasic5BrowserRequest(budget, route, () => {});
      expect(route.continue).toHaveBeenCalledOnce();
    };
    await routeOne('/people/person', 'document');
    budget.setNavigationBucket(1);
    await routeOne('/people/person', 'document');
    await routeOne('/_next/static/chunks/app.js', 'script');
    await routeOne('/public/logo.svg', 'image');
    await routeOne('/people/person?_rsc=private-query-value', 'fetch');
    await routeOne('/people/person?_rsc=prefetch-query-value', 'fetch');
    budget.setNavigationBucket(BASIC5_AUTHENTICATED_NAVIGATION_COUNT);
    await routeOne('/people/person', 'fetch');
    checkTotals(budget);
    const diagnostics = budget.snapshot().browserPresentationDiagnostics;
    expect(diagnostics).toEqual({
      bucketMostRecentNavigation: BASIC5_AUTHENTICATED_NAVIGATION_COUNT,
      byNavigation: Array.from(
        { length: BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1 },
        (_, index) => ({
          document: index === 0 || index === 1 ? 1 : 0,
          next_static_asset: index === 1 ? 1 : 0,
          public_asset: index === 1 ? 1 : 0,
          rsc_or_prefetch: index === 1 ? 2 : 0,
          other: index === BASIC5_AUTHENTICATED_NAVIGATION_COUNT ? 1 : 0,
        }),
      ),
      totals: { document: 2, next_static_asset: 1, public_asset: 1, rsc_or_prefetch: 2, other: 1 },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private-query-value');
    expect(JSON.stringify(diagnostics)).not.toContain('prefetch-query-value');
    expect(budget.snapshot().browserPresentationHttpRequests).toBe(7);
    const laterSnapshot = budget.snapshot().browserPresentationDiagnostics;
    expect(laterSnapshot).not.toBe(diagnostics);
    expect(laterSnapshot?.byNavigation).not.toBe(diagnostics?.byNavigation);
    expect(laterSnapshot?.byNavigation[0]).not.toBe(diagnostics?.byNavigation[0]);
  });

  it('keeps request routing available but marks diagnostics unknown outside the fixed stage buckets', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    budget.setNavigationBucket(BASIC5_AUTHENTICATED_NAVIGATION_COUNT + 1);
    const route = fakeRoute(`${baseUrl}/people/person`, 'GET', [], 'document');
    await routeBasic5BrowserRequest(budget, route, (allowed) => expect(allowed).toBe(true));
    expect(route.continue).toHaveBeenCalledOnce();
    expect(budget.snapshot().browserPresentationDiagnostics).toBeNull();
    expect(budget.snapshot().browserBudgetExceeded).toBe(false);
  });

  it('keeps diagnostic counts unknown if request metadata is invalid without changing fail-closed routing', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const events: string[] = [];
    const route = fakeRoute(`${baseUrl}/people/person`, 'GET', events, 'unknown');
    await routeBasic5BrowserRequest(budget, route, (allowed) => {
      events.push('decision');
      expect(allowed).toBe(true);
    });
    expect(events).toEqual(['decision', 'continue']);
    expect(budget.snapshot()).toMatchObject({
      browserHttpRequests: 1,
      browserControlHttpRequests: 0,
      browserPresentationHttpRequests: 1,
      browserBudgetExceeded: false,
      browserPresentationDiagnostics: null,
    });
  });

  it('keeps routing intact if optional request metadata throws', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const events: string[] = [];
    const route = fakeRoute(`${baseUrl}/people/person`, 'GET', events);
    route.request = () => ({
      url: () => `${baseUrl}/people/person`,
      method: () => 'GET',
      resourceType: () => {
        throw new Error('sensitive diagnostic-only value');
      },
    });
    await routeBasic5BrowserRequest(budget, route, (allowed) => {
      events.push('decision');
      expect(allowed).toBe(true);
    });
    expect(events).toEqual(['decision', 'continue']);
    expect(budget.snapshot().browserPresentationDiagnostics).toBeNull();
    expect(JSON.stringify(budget.snapshot())).not.toContain('sensitive diagnostic-only value');
  });

  it('marks diagnostics unknown for oversized request metadata without retaining it', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const events: string[] = [];
    const longQuery = 'private-query-value'.repeat(600);
    const route = fakeRoute(`${baseUrl}/people/person?value=${longQuery}`, 'GET', events, 'fetch');
    await routeBasic5BrowserRequest(budget, route, (allowed) => {
      events.push('decision');
      expect(allowed).toBe(true);
    });
    expect(events).toEqual(['decision', 'continue']);
    expect(budget.snapshot().browserPresentationDiagnostics).toBeNull();
    expect(JSON.stringify(budget.snapshot())).not.toContain('private-query-value');
  });

  it('counts control request 65 before the adapter records and aborts it, with no later reset', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    for (let count = 1; count <= 64; count++)
      expect(budget.observe(`${baseUrl}/api/people/editor`, 'POST')).toBe(true);
    const events: string[] = [];
    const route = fakeRoute(`${baseUrl}/api/profile/knowledge/family`, 'POST', events);
    await routeBasic5BrowserRequest(budget, route, (allowed, snapshot) => {
      events.push('decision');
      expect(allowed).toBe(false);
      expect(budgetCounts(snapshot)).toEqual({
        browserHttpRequests: 65,
        browserControlHttpRequests: 65,
        browserPresentationHttpRequests: 0,
        browserBudgetExceeded: true,
      });
      expect(snapshot.browserPresentationDiagnostics?.totals).toEqual({
        document: 0,
        next_static_asset: 0,
        public_asset: 0,
        rsc_or_prefetch: 0,
        other: 0,
      });
    });
    expect(events).toEqual(['decision', 'abort:blockedbyclient']);
    expect(route.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 66,
      browserControlHttpRequests: 65,
      browserPresentationHttpRequests: 1,
      browserBudgetExceeded: true,
    });
  });

  it('counts and blocks presentation GET 257 in the actual route adapter', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    for (let count = 1; count <= 257; count++) {
      const events: string[] = [];
      const route = fakeRoute(`${baseUrl}/people/person`, 'GET', events, 'document');
      await routeBasic5BrowserRequest(budget, route, (allowed) => {
        expect(allowed).toBe(count <= 256);
      });
      expect(events).toEqual(count <= 256 ? ['continue'] : ['abort:blockedbyclient']);
    }
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 257,
      browserControlHttpRequests: 0,
      browserPresentationHttpRequests: 257,
      browserBudgetExceeded: true,
    });
    expect(budget.snapshot().browserPresentationDiagnostics?.totals).toEqual({
      document: 257,
      next_static_asset: 0,
      public_asset: 0,
      rsc_or_prefetch: 0,
      other: 0,
    });
  });

  it('admits 320 total requests within both caps, then counts and blocks request 321', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    for (let count = 0; count < 64; count++)
      expect(budget.observe(`${baseUrl}/api`, 'GET')).toBe(true);
    for (let count = 0; count < 256; count++)
      expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(true);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 320,
      browserControlHttpRequests: 64,
      browserPresentationHttpRequests: 256,
      browserBudgetExceeded: false,
    });
    expect(budget.observe(`${baseUrl}/api`, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 321,
      browserControlHttpRequests: 65,
      browserPresentationHttpRequests: 256,
      browserBudgetExceeded: true,
    });
  });

  it.each([
    ['/api', 'GET', false, true],
    ['/api/', 'GET', false, true],
    ['/api/people', 'GET', false, true],
    ['/%61pi/people', 'GET', false, true],
    ['/a%70i/people', 'GET', false, true],
    ['/%61%70%69', 'GET', false, true],
    ['/API/people', 'GET', false, true],
    ['/%41pi/people', 'GET', false, true],
    ['/api?q=a%2Fb&dot=%2E', 'GET', false, true],
    ['/apiary', 'GET', false, false],
    ['/api-like', 'GET', false, false],
    ['/people', 'GET', false, false],
    ['/people?_rsc=synthetic&prefetch=a%2Fb', 'GET', false, false],
    ['/_next/static/chunks/known.js', 'GET', false, false],
    ['/_next/static/chunks/app/%5Bid%5D/page.js', 'GET', false, false],
    ['/public/icon.svg', 'GET', false, false],
    ['/_next/static/chunks/known.js', 'HEAD', false, true],
    ['/_next/static/chunks/known.js', 'OPTIONS', false, true],
    ['/_next/static/chunks/known.js', 'POST', false, true],
    ['/people', 'get', false, true],
    ['/people', 'GET ', false, true],
    ['/people', 'GETX', false, true],
    ['/people/person', 'GET', true, true],
    ['/_next/static/chunks/known.js', 'GET', true, true],
    ['/api/people', 'GET', true, true],
  ] as const)(
    'places %s %s (manual probe=%s) in exactly one bucket',
    (pathname, method, anonymousProbe, control) => {
      const budget = createBasic5BrowserRequestBudget(baseUrl);
      expect(budget.observe(`${baseUrl}${pathname}`, method, anonymousProbe)).toBe(true);
      expect(checkTotals(budget)).toEqual({
        browserHttpRequests: 1,
        browserControlHttpRequests: control ? 1 : 0,
        browserPresentationHttpRequests: control ? 0 : 1,
        browserBudgetExceeded: false,
      });
    },
  );

  it.each([
    'http://remote.example.test/people',
    'https://127.0.0.1:3107/people',
    'http://127.0.0.1:3108/people',
    'http://user:password@127.0.0.1:3107/people',
    'http://@127.0.0.1:3107/people',
    'ftp://127.0.0.1:3107/people',
    '/people',
    'not a URL',
    `${baseUrl}/\npeople`,
    `${baseUrl}/people#fragment`,
    `${baseUrl}/people#`,
    `${baseUrl}/people?q=%`,
    `${baseUrl}/people?q=%ZZ`,
    `${baseUrl}/people?q=%C0%AF`,
    `${baseUrl}/people/sub/../person`,
    `${baseUrl}/people/./person`,
    `${baseUrl}/%2e/api/people`,
    `${baseUrl}/%2E%2e/api/people`,
    `${baseUrl}/api%2fpeople`,
    `${baseUrl}/api%5cpeople`,
    `${baseUrl}/api\\people`,
    `${baseUrl}//api/people`,
    `${baseUrl}/api%/people`,
    `${baseUrl}/%2561pi/people`,
    `${baseUrl}/%00api/people`,
    `${baseUrl}/api%0A/people`,
    `${baseUrl}/people%0D`,
    `${baseUrl}/people%7F`,
    `${baseUrl}/people%C2%85`,
    `${baseUrl}/people%E2%80%A8`,
    `${baseUrl}/api%3Fpeople`,
    `${baseUrl}/api%23people`,
  ])(
    'counts malformed or foreign URL as control and denies it before the route action: %s',
    async (url) => {
      const budget = createBasic5BrowserRequestBudget(baseUrl);
      const events: string[] = [];
      const route = fakeRoute(url, 'GET', events);
      await routeBasic5BrowserRequest(budget, route, (allowed, snapshot) => {
        events.push('decision');
        expect(allowed).toBe(false);
        expect(budgetCounts(snapshot)).toEqual({
          browserHttpRequests: 1,
          browserControlHttpRequests: 1,
          browserPresentationHttpRequests: 0,
          browserBudgetExceeded: false,
        });
      });
      expect(events).toEqual(['decision', 'abort:blockedbyclient']);
      expect(route.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
      expect(route.continue).not.toHaveBeenCalled();
      checkTotals(budget);
    },
  );

  it('does not retry an allowed route when its real action seam rejects', async () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    const events: string[] = [];
    const route = fakeRoute(`${baseUrl}/people`, 'GET', events);
    const cause = new Error('offline route continuation failed');
    route.continue.mockRejectedValueOnce(cause);
    await expect(
      routeBasic5BrowserRequest(budget, route, () => {
        events.push('decision');
      }),
    ).rejects.toBe(cause);
    expect(events).toEqual(['decision']);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 1,
      browserControlHttpRequests: 0,
      browserPresentationHttpRequests: 1,
      browserBudgetExceeded: false,
    });
  });

  it('returns independent content-free count snapshots', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl);
    expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(true);
    const snapshot = budget.snapshot();
    snapshot.browserHttpRequests = 999;
    snapshot.browserBudgetExceeded = true;
    expect(budget.snapshot()).toEqual({
      browserHttpRequests: 1,
      browserControlHttpRequests: 0,
      browserPresentationHttpRequests: 1,
      browserBudgetExceeded: false,
      browserPresentationDiagnostics: null,
    });
    expect(JSON.stringify(budget.snapshot())).not.toContain(baseUrl);
    expect(JSON.stringify(budget.snapshot())).not.toContain('/people');
  });
});

function anonymousResponse(input: {
  status: number;
  location?: string;
  contentType?: string;
  body?: string;
  protectedMarkers?: readonly string[];
}) {
  return () =>
    assertBasic5AnonymousPageResponse({
      status: input.status,
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      body: Buffer.from(input.body ?? ''),
      baseUrl: authBaseUrl,
      protectedMarkers: input.protectedMarkers ?? defaultProtectedMarkers,
    });
}

describe('BASIC5 browser acceptance support', () => {
  it('classifies only recognized Chromium request failures without retaining error text', () => {
    const cases = [
      ['net::ERR_BLOCKED_BY_CLIENT', 'blocked_by_client'],
      ['page.goto: net::ERR_ABORTED', 'aborted'],
      ['net::ERR_CONNECTION_REFUSED', 'connection'],
      ['net::ERR_CONNECTION_RESET', 'connection'],
      ['net::ERR_TIMED_OUT', 'timeout'],
      ['net::ERR_NAME_NOT_RESOLVED', 'name_resolution'],
      ['net::ERR_DNS_TIMED_OUT', 'name_resolution'],
      ['provider secret: private-route-token', 'other'],
      ['net::ERR_ABORTED'.padEnd(513), 'other'],
      ['net::ERR_CERT_AUTHORITY_INVALID', 'other'],
      ['net::ERR_ABORTED then net::ERR_CONNECTION_RESET', 'other'],
    ] as const;
    for (const [errorText, expected] of cases) {
      expect(classifyBasic5RequestFailure(errorText)).toBe(expected);
      expect(JSON.stringify({ category: classifyBasic5RequestFailure(errorText) })).not.toContain(
        errorText,
      );
    }
    for (const value of [undefined, null, 42, {}, ['net::ERR_ABORTED']])
      expect(classifyBasic5RequestFailure(value)).toBe('unknown');
  });

  it('keeps observed counts only when they are bounded safe integers', () => {
    for (const [value, expected] of [
      [0, 0],
      [1, 1],
      [1_000_000, 1_000_000],
      [-1, null],
      [1_000_001, null],
      [1.5, null],
      [Number.MAX_SAFE_INTEGER + 1, null],
      [Number.NaN, null],
      [Infinity, null],
      ['3', null],
      [null, null],
      [undefined, null],
    ] as const) {
      expect(boundedBasic5ObservedCount(value)).toBe(expected);
    }
  });

  it('accepts the configured same-origin Google sign-in HTTP redirect', () => {
    expect(
      anonymousResponse({
        status: 307,
        location: '/api/auth/signin',
      }),
    ).not.toThrow();
    expect(
      anonymousResponse({
        status: 307,
        location: `${authBaseUrl}/api/auth/signin`,
      }),
    ).not.toThrow();
  });

  it('accepts the exact streamed redirect markup emitted by the installed Next renderer', async () => {
    const redirectError = nextRedirect.getRedirectError('/api/auth/signin', 'replace');
    const renderInsertedHtml = nextServerInsertedHtml.makeGetServerInsertedHTML({
      polyfills: [],
      renderServerInsertedHTML: () => [],
      serverCapturedErrors: [redirectError],
      tracingMetadata: undefined,
      basePath: '',
    });
    const body = await renderInsertedHtml();

    expect(body).toContain('id="__next-page-redirect"');
    expect(() =>
      assertBasic5AnonymousPageResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: Buffer.from(body),
        baseUrl: authBaseUrl,
        protectedMarkers: defaultProtectedMarkers,
      }),
    ).not.toThrow();
  });

  it('accepts Next inserting the redirect after the head has committed into the body', async () => {
    const redirectError = nextRedirect.getRedirectError('/api/auth/signin', 'replace');
    const capturedErrors: (Error & { digest: string })[] = [];
    const getInsertedHtml = nextServerInsertedHtml.makeGetServerInsertedHTML({
      polyfills: [],
      renderServerInsertedHTML: () => [],
      serverCapturedErrors: capturedErrors,
      tracingMetadata: undefined,
      basePath: '',
    });
    const transform = nextStreamHelper.createHeadInsertionTransformStream(getInsertedHtml);
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const output: Uint8Array[] = [];
    const drain = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) output.push(value);
      }
    })();

    await writer.write(new TextEncoder().encode('<html><head></head><body>'));
    capturedErrors.push(redirectError);
    await writer.write(new TextEncoder().encode('<main>Public shell</main></body></html>'));
    await writer.close();
    await drain;
    const body = Buffer.concat(output.map((chunk) => Buffer.from(chunk)));
    const html = body.toString('utf8');

    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('__next-page-redirect'));
    expect(html.indexOf('__next-page-redirect')).toBeLessThan(html.indexOf('<main>'));
    expect(() =>
      assertBasic5AnonymousPageResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body,
        baseUrl: authBaseUrl,
        protectedMarkers: defaultProtectedMarkers,
      }),
    ).not.toThrow();
  });

  it('rejects status, destination, ambiguity, malformed markup, and empty-body near misses', () => {
    const invalid = [
      anonymousResponse({ status: 200, location: '/api/auth/signin' }),
      anonymousResponse({ status: 302, location: '/api/auth/signin' }),
      anonymousResponse({ status: 307, location: 'https://outside.example/api/auth/signin' }),
      anonymousResponse({ status: 307, location: '/api/auth/signin?next=/people' }),
      anonymousResponse({ status: 307, location: '/api/auth/signin#fragment' }),
      anonymousResponse({ status: 307, location: 'http://user@127.0.0.1:3107/api/auth/signin' }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/people">',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><meta http-equiv="refresh" content="1;url=/people">',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<base href="https://outside.example/"><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<!-- <meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"> -->',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<script>const fake = \'<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">\';</script>',
      }),
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<template><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"></template>',
      }),
      ...['textarea', 'iframe', 'title', 'xmp', 'noembed', 'noframes', 'plaintext'].map((tag) =>
        anonymousResponse({
          status: 200,
          contentType: anonymousHtmlContentType,
          body: `<${tag}><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"></${tag}>`,
        }),
      ),
      ...['svg', 'math', 'select', 'div'].map((tag) =>
        anonymousResponse({
          status: 200,
          contentType: anonymousHtmlContentType,
          body: `<html><head></head><body><${tag}><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"></${tag}></body></html>`,
        }),
      ),
      anonymousResponse({
        status: 200,
        contentType: 'application/json',
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">',
      }),
      anonymousResponse({
        status: 307,
        location: '/api/auth/signin',
        body: '<meta http-equiv="refresh" content="1;url=/people">',
      }),
    ];
    for (const check of invalid) expect(check).toThrow();
  });

  it('rejects protected fixture text in HTML, entity-decoded text, attributes, and JSON strings', () => {
    const marker = 'private <person> & note';
    const nextRedirectMeta =
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">';
    const bodies = [
      `${nextRedirectMeta}<main>${marker}</main>`,
      `${nextRedirectMeta}<main>private &lt;person&gt; &amp; note</main>`,
      `${nextRedirectMeta}<div title="private &lt;person&gt; &amp; note"></div>`,
    ];
    for (const body of bodies)
      expect(
        anonymousResponse({
          status: 200,
          contentType: anonymousHtmlContentType,
          body,
          protectedMarkers: [marker],
        }),
      ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');

    const escapedMarker = 'private "line"\nnote';
    expect(
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: `${nextRedirectMeta}<script>self.data=${JSON.stringify(escapedMarker)}</script>`,
        protectedMarkers: [escapedMarker],
      }),
    ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');

    expect(
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><script>self.data="\\u0041lex Rivera"</script>',
        protectedMarkers: ['Alex Rivera'],
      }),
    ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');

    for (const encodedMarker of ['\\x41lex Rivera', '\\u{41}lex Rivera'])
      expect(
        anonymousResponse({
          status: 200,
          contentType: anonymousHtmlContentType,
          body: `<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><script>self.data="${encodedMarker}"</script>`,
          protectedMarkers: ['Alex Rivera'],
        }),
      ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');

    for (const encodedMarker of ['\\x41le\\u0078 Rivera', '&#x41;le\\u0078 Rivera'])
      expect(
        anonymousResponse({
          status: 200,
          contentType: anonymousHtmlContentType,
          body: `<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><div title="${encodedMarker}"></div>`,
          protectedMarkers: ['Alex Rivera'],
        }),
      ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');
  });

  it('rejects an editor command marker and oversized or invalid UTF-8 bodies without echoing them', () => {
    expect(
      anonymousResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"><script>create_owner_memory</script>',
        protectedMarkers: ['create_owner_memory'],
      }),
    ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');

    expect(() =>
      assertBasic5AnonymousPageResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: Buffer.alloc(64 * 1024 + 1),
        baseUrl: authBaseUrl,
        protectedMarkers: defaultProtectedMarkers,
      }),
    ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');
    expect(() =>
      assertBasic5AnonymousPageResponse({
        status: 200,
        contentType: anonymousHtmlContentType,
        body: Buffer.from([0xff]),
        baseUrl: authBaseUrl,
        protectedMarkers: defaultProtectedMarkers,
      }),
    ).toThrow('BASIC5 anonymous person-page response did not satisfy the auth boundary');
  });

  it('pins CI to the installed Chrome channel without changing local launch defaults', () => {
    expect(basic5BrowserLaunchOptions(true)).toEqual({ headless: true, channel: 'chrome' });
    expect(basic5BrowserLaunchOptions(false)).toEqual({ headless: true });
  });

  it('bounds standalone readiness attempts independently of browser request limits', () => {
    expect(BASIC5_READINESS_ATTEMPT_LIMIT).toBe(451);
    expect(nextBasic5ReadinessAttempt(0)).toBe(1);
    expect(nextBasic5ReadinessAttempt(BASIC5_READINESS_ATTEMPT_LIMIT - 1)).toBe(
      BASIC5_READINESS_ATTEMPT_LIMIT,
    );
    expect(() => nextBasic5ReadinessAttempt(BASIC5_READINESS_ATTEMPT_LIMIT)).toThrow(
      'BASIC5 readiness attempt limit exceeded',
    );
    expect(() => nextBasic5ReadinessAttempt(-1)).toThrow('BASIC5 readiness attempt limit exceeded');
  });

  it('issues a bounded Auth.js cookie that the actual Auth.js JWT decoder accepts', async () => {
    const cookie = await createBasic5AuthCookie({
      email: 'owner@example.test',
      subject: '11111111-1111-4111-8111-111111111111',
      formSessionScope: 'basic5_fixture_session_scope',
      secret,
    });
    expect(cookie.name).toBe(BASIC5_AUTH_COOKIE_NAME);
    expect(cookie.value.length).toBeLessThan(3_936);
    await expect(decodeBasic5AuthCookie(cookie, secret)).resolves.toMatchObject({
      email: 'owner@example.test',
      sub: '11111111-1111-4111-8111-111111111111',
      assistantFormSessionScope: 'basic5_fixture_session_scope',
    });
  });

  it('rejects malformed synthetic claims and undersized signing secrets', async () => {
    await expect(
      createBasic5AuthCookie({
        email: 'not-an-email',
        subject: 'owner',
        formSessionScope: 'short',
        secret,
      }),
    ).rejects.toThrow('Invalid synthetic Auth.js session claims');
    await expect(
      createBasic5AuthCookie({
        email: 'owner@example.test',
        subject: 'owner',
        formSessionScope: 'basic5_fixture_session_scope',
        secret: 'too-short',
      }),
    ).rejects.toThrow('at least 32 bytes');
  });

  it('empties known provider credentials before Next can load dotenv files', () => {
    const env = basic5IsolatedWebEnvironment({
      source: {
        PATH: '/usr/bin',
        OPENROUTER_API_KEY: 'ambient-real-key',
        AUTH_GOOGLE_SECRET: 'ambient-real-secret',
        GOOGLE_OAUTH_CLIENT_SECRET: 'ambient-oauth-secret',
        BOT_GOOGLE_REFRESH_TOKEN: 'ambient-refresh-token',
        TWILIO_AUTH_TOKEN: 'ambient-twilio-token',
        GITHUB_TOKEN: 'ambient-github-token',
        MOBILE_API_TOKEN: 'ambient-mobile-token',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        OWNER_NAME: 'Fixture Owner',
      },
      databaseUrl: 'postgres://assistant:assistant@127.0.0.1:55432/assistant_fixture_test',
      targetToken: '0123456789abcdef01234567',
      ownerEmail: 'owner@example.test',
      ownerName: 'Synthetic Test Owner',
      authSecret: secret,
      emptyHome: '/tmp/basic5-empty-home',
      authUrl: 'http://127.0.0.1:3107',
      embeddingBaseUrl: 'http://127.0.0.1:3108/v1',
      denyEgressPreloader: '/repo/scripts/deny-test-egress.mjs',
    });
    for (const key of [
      'OPENROUTER_API_KEY',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'BOT_GOOGLE_REFRESH_TOKEN',
      'TWILIO_AUTH_TOKEN',
      'GITHUB_TOKEN',
      'MOBILE_API_TOKEN',
    ])
      expect(env[key]).toBe('');
    expect(env.AUTH_SECRET).toBe(secret);
    expect(env.AUTH_GOOGLE_SECRET).toBe('synthetic-auth-cookie-only-secret');
    expect(env.AUTH_DEV_BYPASS).toBe('false');
    expect(env.OWNER_AUTH_MODE).toBe('google');
    expect(env.DATABASE_URL).toBe(env.TEST_DATABASE_URL);
    expect(env.ASSISTANT_TEST_TARGET_TOKEN).toBe('0123456789abcdef01234567');
    expect(env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS).toBe('1');
    expect(env.NODE_OPTIONS).toContain('--import=/repo/scripts/deny-test-egress.mjs');
    expect(env.OWNER_NAME).toBe('Synthetic Test Owner');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/basic5-empty-home');
    expect(env.NODE_ENV).toBe('production');
    expect(env.LLM_PROVIDER).toBe('vertex');
    expect(env.OWNER_NAME).toBe('Synthetic Test Owner');
    expect(env.ASSISTANT_NAME).toBe('Synthetic Test Owner');
    expect(env.ASSISTANT_EMAIL).toBe('owner@example.test');
    expect(env.OWNER_PHONE).toBe('');
  });

  it('returns bounded deterministic OpenAI-compatible vectors without echoing note text', () => {
    const reply = basic5EmbeddingResponse({ input: ['private note', 'private relation'] });
    expect(reply.data).toHaveLength(2);
    expect(reply.data[0]?.embedding).toHaveLength(BASIC5_EMBEDDING_DIMENSIONS);
    expect(reply.data[0]?.embedding[0]).toBe(1);
    expect(reply.data[0]?.embedding.slice(1).every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('private');
    expect(() => basic5EmbeddingResponse({ input: [] })).toThrow('out of bounds');
    expect(() => basic5EmbeddingResponse({ input: Array(101).fill('x') })).toThrow('out of bounds');
  });

  it('requires exactly four distinct saved receipts in the approved command order', () => {
    const posts = BASIC5_BROWSER_ACTIONS.map((command, index) => ({
      command,
      operationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      authority: 'operation_receipt',
      outcome: 'saved',
    }));
    expect(() => assertBasic5ReceiptSequence(posts)).not.toThrow();
    expect(() => assertBasic5ReceiptSequence(posts.slice(0, 3))).toThrow('four distinct');
    const duplicateOperation = posts.map((post, index) => ({
      ...post,
      operationId: index === 3 ? (posts[0]?.operationId ?? 'missing') : post.operationId,
    }));
    expect(() => assertBasic5ReceiptSequence(duplicateOperation)).toThrow('four distinct');
  });
});
