import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectRuntimeDiagnostics,
  DIAGNOSTIC_SERVICE,
  DiagnosticError,
  diagnosticWindow,
  HISTORICAL_DIAGNOSTIC_REVISION,
  LOG_FIELDS,
  libraryLogFilter,
  runtimeDiagnosticClient,
} from './owner-web-runtime-diagnostics.js';
import { verifyRuntimeDiagnosticContext } from './owner-web-runtime-diagnostics-command.js';

const current = 'assistant-web-01087-dup';
const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'a'.repeat(64)}`;
const secret = 'PRIVATE_RECORD_CREDENTIAL_QUERY_AND_SESSION';
const window = { start: '2026-11-01T17:20:00.000Z', end: '2026-11-01T17:35:00.000Z' };
const config = () => ({
  timeout: '300s',
  maxInstanceRequestConcurrency: 80,
  scaling: { minInstanceCount: 0, maxInstanceCount: 100 },
  containers: [
    {
      image,
      resources: {
        limits: { cpu: '0.5', memory: '512Mi', secret },
        cpuIdle: true,
        startupCpuBoost: false,
      },
      env: [{ name: 'SECRET', value: secret }],
    },
  ],
});
const service = () => ({
  name: DIAGNOSTIC_SERVICE,
  uid: '11111111-1111-4111-8111-111111111111',
  etag: 'fixed-etag',
  generation: '5',
  observedGeneration: '5',
  reconciling: false,
  terminalCondition: { state: 'CONDITION_SUCCEEDED', message: secret },
  traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: current, percent: 100 }],
  trafficStatuses: [
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: current, percent: 100 },
  ],
  template: config(),
  scaling: { minInstanceCount: 2 },
  annotations: { secret },
});
const nativeRevision = (name = current) => ({
  name: `${DIAGNOSTIC_SERVICE}/revisions/${name}`,
  uid: '22222222-2222-4222-8222-222222222222',
  ...config(),
  labels: { secret },
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(
  options: { pages?: unknown[]; final?: unknown; loggingStatus?: number; history?: boolean } = {},
) {
  let serviceReads = 0,
    page = 0;
  const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'logging.googleapis.com')
      return response(options.pages?.[page++] ?? {}, options.loggingStatus ?? 200);
    if (url.pathname.endsWith(`/revisions/${current}`)) return response(nativeRevision());
    if (url.pathname.endsWith(`/revisions/${HISTORICAL_DIAGNOSTIC_REVISION}`))
      return response(nativeRevision(HISTORICAL_DIAGNOSTIC_REVISION));
    return response(serviceReads++ === 0 ? service() : (options.final ?? service()));
  });
  return { request, client: runtimeDiagnosticClient('fake-existing-token', request, () => 0) };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T18:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('bounded separate runtime diagnostics', () => {
  it('retains only whitelisted configuration, separating revision/template/service and missing fields', async () => {
    const { client, request } = fixture({ pages: [{}] });
    const result = await collectRuntimeDiagnostics(client, window, true);
    expect(result.currentRevision).toMatchObject({
      timeoutSeconds: { state: 'observed', value: 300 },
      concurrency: { state: 'observed', value: 80 },
      cpu: { state: 'observed', value: '0.5' },
      memory: { state: 'observed', value: '512Mi' },
      startupCpuBoost: { state: 'observed', value: false },
    });
    expect(result.serviceScaling).toMatchObject({
      minInstances: { state: 'observed', value: 2 },
      maxInstances: { state: 'not_returned' },
      mode: { state: 'not_returned' },
    });
    expect(result.currentRevision.scaling.minInstances).toEqual({ state: 'observed', value: 0 });
    expect(result.nextRevisionTemplate.scope).toBe('web_container_only');
    expect(result.servingSourceSHA).toEqual({ state: 'not_qualified_by_configuration_read' });
    expect(result.mutationAuthority).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(request).toHaveBeenCalledTimes(5);
    for (const [input, init] of request.mock.calls) {
      const url = new URL(String(input));
      expect(['run.googleapis.com', 'logging.googleapis.com']).toContain(url.hostname);
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe(url.hostname === 'logging.googleapis.com' ? 'POST' : 'GET');
      expect(url.searchParams.get('fields')).toBeTruthy();
      expect(url.searchParams.get('fields')).not.toMatch(
        /env|annotations|textPayload|jsonPayload|requestUrl|remoteIp|userAgent/,
      );
    }
  });
  it('makes omission distinct from explicit defaults and preserves fractional timeouts', async () => {
    const { request, client } = fixture();
    request.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('logging.googleapis.com')) return response({});
      if (url.includes('/revisions/'))
        return response({
          name: `${DIAGNOSTIC_SERVICE}/revisions/${current}`,
          timeout: '0.123456789s',
          containers: [{ image }],
        });
      return response(service());
    });
    const result = await collectRuntimeDiagnostics(client, window);
    expect(result.currentRevision.timeoutSeconds).toEqual({
      state: 'observed',
      value: 0.123456789,
    });
    expect(result.currentRevision.concurrency).toEqual({ state: 'not_returned' });
    expect(result.currentRevision.cpuIdle).toEqual({ state: 'not_returned' });
    expect(result.currentRevision.cpu).toEqual({ state: 'not_returned' });
  });
  it('uses a fixed canonical Library filter and does not return URL, trace, payload or individual request data', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      timestamp: '2026-11-01T17:25:12.123456789Z',
      httpRequest: {
        status: i < 2 ? 500 : 200,
        latency: `${i + 1}.125s`,
        requestUrl: secret,
        remoteIp: secret,
        userAgent: secret,
      },
      textPayload: secret,
      jsonPayload: { body: secret },
      trace: secret,
    }));
    const { client, request } = fixture({ pages: [{ entries: rows }] });
    const result = await collectRuntimeDiagnostics(client, window);
    expect(result.timing).toMatchObject({
      status: 'bounded_sample',
      returnedEntries: 10,
      validDurations: 10,
      sampleP50Milliseconds: 5125,
      sampleP95Milliseconds: 10125,
      truncated: false,
    });
    expect(result.timing.buckets).toEqual([
      { minute: '2026-11-01T17:25:00Z', statusClass: '2xx', count: 8 },
      { minute: '2026-11-01T17:25:00Z', statusClass: '5xx', count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${secret}|requestUrl|remoteIp|trace|textPayload|jsonPayload`),
    );
    const call = request.mock.calls.find(([input]) =>
      String(input).includes('logging.googleapis.com'),
    );
    if (!call) throw new Error('Expected bounded logging request');
    expect(new URL(String(call[0])).searchParams.get('fields')).toBe(LOG_FIELDS);
    const body = JSON.parse(String(call[1]?.body));
    expect(body).toEqual({
      resourceNames: ['projects/bmson-assistant'],
      filter: libraryLogFilter(window, current),
      orderBy: 'timestamp desc',
      pageSize: 100,
    });
    expect(body.filter).toContain('resource.labels.revision_name="assistant-web-01087-dup"');
    expect(body.filter).toContain('view=library');
    expect(body.filter).not.toContain(secret);
  });
  it('returns a bounded empty sample, not zero backend latency or a healthy verdict', async () => {
    const { client } = fixture();
    const result = await collectRuntimeDiagnostics(client, window);
    expect(result.timing).toMatchObject({
      status: 'bounded_sample',
      returnedEntries: 0,
      validDurations: 0,
      sampleP50Milliseconds: null,
      sampleP95Milliseconds: null,
      coverage: 'bounded_sample_not_whole_backend_or_browser',
    });
  });
  it('keeps denied log access unavailable while returning stable configuration, without retrying', async () => {
    const { client, request } = fixture({ loggingStatus: 403, pages: [{ textPayload: secret }] });
    const result = await collectRuntimeDiagnostics(client, window);
    expect(result.timing).toEqual({ status: 'unavailable', reason: 'access_denied' });
    expect(
      request.mock.calls.filter(([input]) => String(input).includes('logging.googleapis.com')),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('binds pagination to the fixed filter/window, caps two pages and marks incomplete coverage', async () => {
    const { client, request } = fixture({
      pages: [{ nextPageToken: 'page-two' }, { nextPageToken: 'unread-page-three' }],
    });
    const result = await collectRuntimeDiagnostics(client, window);
    expect(result.timing).toMatchObject({
      truncated: true,
      returnedEntries: 0,
      sampleP95Milliseconds: null,
    });
    const calls = request.mock.calls.filter(([input]) =>
      String(input).includes('logging.googleapis.com'),
    );
    expect(calls).toHaveLength(2);
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).toEqual({ ...bodies[0], pageToken: 'page-two' });
    expect(JSON.stringify(result)).not.toContain('unread-page-three');
  });
  it('does not convert malformed rows or absent durations into fast or healthy observations', async () => {
    const { client } = fixture({
      pages: [
        {
          entries: [
            { timestamp: '2026-11-01T17:25:00Z', httpRequest: { status: 503 } },
            { timestamp: secret, httpRequest: { status: 200, latency: '0s' } },
            { timestamp: '2026-11-01T17:25:00Z', httpRequest: { status: 0, latency: '0s' } },
          ],
        },
      ],
    });
    expect((await collectRuntimeDiagnostics(client, window)).timing).toMatchObject({
      returnedEntries: 3,
      invalidEntries: 2,
      missingOrInvalidDurations: 1,
      validDurations: 0,
      sampleP95Milliseconds: null,
    });
  });
  it.each([
    { uid: '33333333-3333-4333-8333-333333333333' },
    { etag: 'changed-etag' },
    { generation: '6', observedGeneration: '6' },
  ])('refuses service identity/version drift after the bounded read %j', async (change) => {
    const { client } = fixture({ final: { ...service(), ...change } });
    await expect(collectRuntimeDiagnostics(client, window)).rejects.toMatchObject({
      reason: 'identity_changed',
    });
  });
  it('refuses desired/status disagreement before fetching revisions or logging', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...service(), trafficStatuses: [] }));
    await expect(
      collectRuntimeDiagnostics(runtimeDiagnosticClient('token', request), window),
    ).rejects.toBeInstanceOf(DiagnosticError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    '../elsewhere',
    'assistant-agent-current',
    `${DIAGNOSTIC_SERVICE}/revisions/${current}`,
    'https://operator.invalid',
  ])('refuses revision target escape before any request: %s', (name) => {
    const request = vi.fn<typeof fetch>();
    expect(() => runtimeDiagnosticClient('token', request).revision(name)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds a stalled body, redacts errors, and never follows a redirect', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T18:00:00.000Z'));
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
      ),
    );
    const pending = runtimeDiagnosticClient('token', request, () => 0)
      .service()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toMatchObject({ reason: 'deadline_exceeded' });
    expect(request).toHaveBeenCalledTimes(1);
    const redirect = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(secret, { status: 302, headers: { Location: 'https://operator.invalid' } }),
      );
    await expect(runtimeDiagnosticClient('token', redirect).service()).rejects.toMatchObject({
      reason: 'read_failed',
    });
    expect(redirect).toHaveBeenCalledTimes(1);
    const failure = vi.fn<typeof fetch>().mockRejectedValue(new Error(secret));
    const error = await runtimeDiagnosticClient('token', failure)
      .service()
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
  });
  it('enforces the total monotonic deadline before another request', async () => {
    let elapsed = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      elapsed = 60001;
      return response(service());
    });
    const client = runtimeDiagnosticClient('token', request, () => elapsed);
    await expect(collectRuntimeDiagnostics(client, window)).rejects.toMatchObject({
      reason: 'deadline_exceeded',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds oversized API responses without retaining provider content', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ payload: secret.repeat(10000) }));
    await expect(runtimeDiagnosticClient('token', request).service()).rejects.toMatchObject({
      reason: 'response_invalid',
    });
  });
});

describe('pre-auth source and window gate', () => {
  const env = () => ({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GCP_PROJECT: 'bmson-assistant',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'deploy@bmson-assistant.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123/locations/global/workloadIdentityPools/existing/providers/existing',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF:
      'bmson/assistant/.github/workflows/owner-web-runtime-diagnostics.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    RUNTIME_DIAGNOSTIC_REVIEWED_SOURCE: 'a'.repeat(40),
    RUNTIME_DIAGNOSTIC_INCLUDE_HISTORICAL: 'false',
    RUNTIME_DIAGNOSTIC_START: window.start,
    RUNTIME_DIAGNOSTIC_END: window.end,
  });
  it('accepts only the exact protected source and validates the time window', () =>
    expect(verifyRuntimeDiagnosticContext(env())).toEqual(window));
  it.each([
    { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { RUNTIME_DIAGNOSTIC_REVIEWED_SOURCE: 'b'.repeat(40) },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_EVENT_NAME: 'push' },
    { GCP_PROJECT: 'other' },
    { RUNTIME_DIAGNOSTIC_INCLUDE_HISTORICAL: 'yes' },
  ])('refuses source/identity overrides before authentication %j', (change) =>
    expect(() => verifyRuntimeDiagnosticContext({ ...env(), ...change })).toThrow(),
  );
  it.each([
    ['2026-11-01T17:19:59.000Z', window.end],
    [window.end, window.start],
    [window.start, '2026-11-02T17:35:00.000Z'],
    ['2026-10-30T17:20:00.000Z', '2026-10-30T17:35:00.000Z'],
    ['2026-02-30T17:20:00.000Z', '2026-02-30T17:35:00.000Z'],
    ['private-filter-injection', window.end],
  ])('rejects invalid/old/future/oversized windows %s %s', (start, end) =>
    expect(() => diagnosticWindow(start, end, Date.now())).toThrow(),
  );
  it('keeps the separate workflow source gate before WIF and grants no added workflow permissions', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/owner-web-runtime-diagnostics.yml', import.meta.url),
      'utf8',
    );
    expect(workflow.indexOf('--verify-source')).toBeLessThan(
      workflow.indexOf('uses: google-github-actions/auth@'),
    );
    expect(workflow).toMatch(/ref: \$\{\{ github\.workflow_sha \}\}/);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('group: production-deploy');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('retention-days: 1');
    expect(workflow).not.toMatch(/actions:|write-all|--apply|owner-web-tag-retirement-command/);
  });
});
