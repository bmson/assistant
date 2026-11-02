import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  assertBasic5AnonymousPageResponse,
  assertBasic5ReceiptSequence,
  BASIC5_AUTH_COOKIE_NAME,
  BASIC5_BROWSER_ACTIONS,
  BASIC5_BROWSER_DYNAMIC_REQUEST_LIMIT,
  BASIC5_BROWSER_STATIC_ASSET_REQUEST_LIMIT,
  BASIC5_BROWSER_TOTAL_REQUEST_LIMIT,
  BASIC5_EMBEDDING_DIMENSIONS,
  BASIC5_READINESS_ATTEMPT_LIMIT,
  basic5BrowserLaunchOptions,
  basic5EmbeddingResponse,
  basic5IsolatedWebEnvironment,
  boundedBasic5ObservedCount,
  classifyBasic5RequestFailure,
  createBasic5AuthCookie,
  createBasic5BrowserRequestBudget,
  decodeBasic5AuthCookie,
  nextBasic5ReadinessAttempt,
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

describe('task-specific BASIC5 browser request budgets', () => {
  const baseUrl = 'http://127.0.0.1:3107';
  const assetPath = '/_next/static/chunks/known.js';
  const bracketPath = '/_next/static/chunks/app/%5Bid%5D/page.js';
  const known = () => new Set([assetPath, bracketPath]);
  const checkTotals = (budget: ReturnType<typeof createBasic5BrowserRequestBudget>) => {
    const snapshot = budget.snapshot();
    expect(snapshot.browserHttpRequests).toBe(
      snapshot.browserDynamicHttpRequests + snapshot.browserStaticAssetRequests,
    );
    return snapshot;
  };

  it('pins the separate dynamic, static, and total caps', () => {
    expect(BASIC5_BROWSER_DYNAMIC_REQUEST_LIMIT).toBe(64);
    expect(BASIC5_BROWSER_STATIC_ASSET_REQUEST_LIMIT).toBe(256);
    expect(BASIC5_BROWSER_TOTAL_REQUEST_LIMIT).toBe(320);
  });

  it('permits more than 64 known static requests followed by a family POST in a synthetic sequence', () => {
    const paths = new Set(
      Array.from({ length: 70 }, (_, index) => `/_next/static/chunks/synthetic-${index}.js`),
    );
    const budget = createBasic5BrowserRequestBudget(baseUrl, paths);
    let oldCombinedCount = 0;
    let oldCombinedWouldBlock = false;
    // This replay illustrates the old combined-cap failure; it does not claim
    // to reconstruct any retained CI run's unknown request sequence.
    expect(budget.observe(`${baseUrl}/people/person`, 'GET')).toBe(true);
    oldCombinedCount += 1;
    for (const pathname of paths) {
      oldCombinedCount += 1;
      oldCombinedWouldBlock ||= oldCombinedCount > 64;
      expect(budget.observe(`${baseUrl}${pathname}`, 'GET')).toBe(true);
    }
    expect(oldCombinedWouldBlock).toBe(true);
    expect(budget.observe(`${baseUrl}/api/profile/knowledge/family`, 'POST')).toBe(true);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 72,
      browserDynamicHttpRequests: 2,
      browserStaticAssetRequests: 70,
      browserBudgetExceeded: false,
    });
  });

  it('counts and blocks dynamic request 65, then keeps the cap violation latched', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl, known());
    for (let count = 1; count <= 64; count++)
      expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}/api/profile/knowledge/family`, 'POST')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 65,
      browserDynamicHttpRequests: 65,
      browserStaticAssetRequests: 0,
      browserBudgetExceeded: true,
    });
    expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 66,
      browserDynamicHttpRequests: 65,
      browserStaticAssetRequests: 1,
      browserBudgetExceeded: true,
    });
  });

  it('counts and blocks static request 257 independently of the dynamic cap', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl, known());
    for (let count = 1; count <= 256; count++)
      expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 257,
      browserDynamicHttpRequests: 0,
      browserStaticAssetRequests: 257,
      browserBudgetExceeded: true,
    });
  });

  it('admits exactly 320 total requests within both class caps, then counts and blocks request 321', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl, known());
    for (let count = 0; count < 64; count++)
      expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(true);
    for (let count = 0; count < 256; count++)
      expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(true);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 320,
      browserDynamicHttpRequests: 64,
      browserStaticAssetRequests: 256,
      browserBudgetExceeded: false,
    });
    expect(budget.observe(`${baseUrl}/people`, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 321,
      browserDynamicHttpRequests: 65,
      browserStaticAssetRequests: 256,
      browserBudgetExceeded: true,
    });
  });

  it.each([
    [assetPath, 'GET', true, true],
    [bracketPath, 'GET', true, true],
    [`${assetPath}?v=a%2Fb&label=a%20b&escaped=%2E%5C%23`, 'GET', true, true],
    [`${assetPath}?`, 'GET', true, true],
    ['/_next/static/chunks/app/[id]/page.js', 'GET', true, false],
    ['/_next/static/chunks/unknown.js', 'GET', true, false],
    ['/_next/staticity/chunks/known.js', 'GET', true, false],
    ['/_next/static-evil/chunks/known.js', 'GET', true, false],
    ['/_next/static', 'GET', true, false],
    [assetPath, 'POST', true, false],
    [assetPath, 'HEAD', true, false],
    [assetPath, 'get', true, false],
    [assetPath, 'GET ', true, false],
    [assetPath, 'GETX', true, false],
    ['/api/profile/knowledge/family', 'POST', true, false],
    [`${assetPath}?q=%`, 'GET', false, false],
    [`${assetPath}?q=%ZZ`, 'GET', false, false],
    [`${assetPath}?q=%C0%AF`, 'GET', false, false],
    [`${assetPath}#fragment`, 'GET', false, false],
    [`${assetPath}#`, 'GET', false, false],
    ['/_next/static/chunks/sub/../known.js', 'GET', false, false],
    ['/_next/static/chunks/./known.js', 'GET', false, false],
    ['/_next/static/chunks/%2e/known.js', 'GET', false, false],
    ['/_next/static/chunks/%2E%2e/known.js', 'GET', false, false],
    ['/_next/static/chunks/known%2ejs', 'GET', false, false],
    ['/_next/static/chunks/known%2f.js', 'GET', false, false],
    ['/_next/static/chunks/known%5c.js', 'GET', false, false],
    ['/_next/static/chunks\\known.js', 'GET', false, false],
    ['/_next/static//chunks/known.js', 'GET', false, false],
    ['/_next/static/chunks/known%.js', 'GET', false, false],
    ['/_next/static/chunks/%252e%252e/known.js', 'GET', false, false],
  ] as const)(
    'classifies raw path/query %s with method %s before admission',
    (pathname, method, allowed, isStatic) => {
      const budget = createBasic5BrowserRequestBudget(baseUrl, known());
      expect(budget.observe(`${baseUrl}${pathname}`, method)).toBe(allowed);
      expect(checkTotals(budget)).toEqual({
        browserHttpRequests: 1,
        browserDynamicHttpRequests: isStatic ? 0 : 1,
        browserStaticAssetRequests: isStatic ? 1 : 0,
        browserBudgetExceeded: false,
      });
    },
  );

  it.each([
    'http://remote.example.test/_next/static/chunks/known.js',
    'https://127.0.0.1:3107/_next/static/chunks/known.js',
    'http://127.0.0.1:3108/_next/static/chunks/known.js',
    'http://user:password@127.0.0.1:3107/_next/static/chunks/known.js',
    'http://@127.0.0.1:3107/_next/static/chunks/known.js',
    'ftp://127.0.0.1:3107/_next/static/chunks/known.js',
    '/_next/static/chunks/known.js',
    'not a URL',
    'http://127.0.0.1:3107/\n_next/static/chunks/known.js',
  ])('counts and denies off-origin or malformed URL %s without claiming cap exhaustion', (url) => {
    const budget = createBasic5BrowserRequestBudget(baseUrl, known());
    expect(budget.observe(url, 'GET')).toBe(false);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 1,
      browserDynamicHttpRequests: 1,
      browserStaticAssetRequests: 0,
      browserBudgetExceeded: false,
    });
  });

  it('snapshots the known file inventory and ignores invalid known-path entries', () => {
    const inventory = new Set([
      assetPath,
      '/api/profile/knowledge/family',
      '/_next/static/',
      '/_next/static/chunks/../chunks/unsafe.js',
      '/_next/static/chunks/unsafe%2f.js',
      '/_next/static/chunks/unknown.js?v=1',
    ]);
    const budget = createBasic5BrowserRequestBudget(baseUrl, inventory);
    inventory.clear();
    inventory.add('/_next/static/chunks/later.js');
    expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}/_next/static/chunks/later.js`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}/api/profile/knowledge/family`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}/_next/static/`, 'GET')).toBe(true);
    expect(budget.observe(`${baseUrl}/_next/static/chunks/unsafe%2f.js`, 'GET')).toBe(false);
    expect(budget.observe(`${baseUrl}/_next/static/chunks/unknown.js?v=1`, 'GET')).toBe(true);
    expect(checkTotals(budget)).toEqual({
      browserHttpRequests: 6,
      browserDynamicHttpRequests: 5,
      browserStaticAssetRequests: 1,
      browserBudgetExceeded: false,
    });
  });

  it('returns independent content-free count snapshots', () => {
    const budget = createBasic5BrowserRequestBudget(baseUrl, known());
    expect(budget.observe(`${baseUrl}${assetPath}`, 'GET')).toBe(true);
    const snapshot = budget.snapshot();
    snapshot.browserHttpRequests = 999;
    snapshot.browserBudgetExceeded = true;
    expect(budget.snapshot()).toEqual({
      browserHttpRequests: 1,
      browserDynamicHttpRequests: 0,
      browserStaticAssetRequests: 1,
      browserBudgetExceeded: false,
    });
    expect(JSON.stringify(budget.snapshot())).not.toContain(baseUrl);
    expect(JSON.stringify(budget.snapshot())).not.toContain(assetPath);
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
