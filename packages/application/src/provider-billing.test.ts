import { describe, expect, it, vi } from 'vitest';
import type { ModelProviderPorts } from './model-providers.js';
import {
  type BillingPorts,
  billingCoverageProjection,
  billingForecast,
  getProviderBilling,
  googleBillingQuery,
  type ProviderBilling,
  projectBillingForMobile,
  readGoogleBilling,
  readOpenAIBilling,
  readOpenRouterBilling,
} from './provider-billing.js';

const now = new Date('2026-09-27T12:00:00Z');
const base: ProviderBilling = {
  id: 'google-cloud',
  label: 'Google Cloud',
  period: '2026-09',
  scope: 'Project: assistant',
  source: 'test',
  status: 'unavailable',
  message: '',
  fetchedAt: null,
  latestExportAt: null,
  latestUsageAt: null,
  lines: [],
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function ports(): BillingPorts {
  const cache = new Map<string, unknown>();
  return {
    config: {
      GCP_PROJECT: 'assistant',
      GCP_BILLING_EXPORT_TABLE: 'billing.data.gcp_billing_export_v1_test',
      GCP_BILLING_QUERY_PROJECT: '',
      GCP_BILLING_LOCATION: 'US',
      GCP_BILLING_SCOPE: 'project',
      GCP_BILLING_MAX_BYTES: 1_000_000_000,
      OPENAI_BILLING_ADMIN_KEY_ENCRYPTED: '',
      OPENAI_BILLING_PROJECT_IDS: '',
      OPENAI_BILLING_API_KEY_IDS: '',
      OPENAI_BILLING_ACCOUNT_LABEL: '',
    },
    models: {
      config: {
        LLM_PROVIDER: 'vertex',
        OPENROUTER_API_KEY: '',
        VERTEX_PROJECT: '',
        VERTEX_LOCATION: 'global',
      },
      connections: { list: vi.fn(async () => []) },
      open: (key: string) => key,
    } as unknown as ModelProviderPorts,
    cache: {
      cacheGet: async (key) => (cache.has(key) ? { result: cache.get(key) } : null),
      cachePut: async (input) => {
        cache.set(input.cacheKey, input.result);
      },
    },
    now: () => now,
    accessToken: async () => 'test-google-token',
  };
}
function row(currency = 'USD', cost = '10', credits = '-3', net = '7') {
  return {
    f: [
      currency,
      'assistant',
      'Cloud Firestore',
      'Document reads',
      'regular',
      cost,
      credits,
      net,
      '2026-09-27T08:00:00Z',
      '2026-09-26T23:00:00Z',
    ].map((v) => ({ v })),
  };
}

describe('provider billing without guessed totals', () => {
  it('uses real credits, adjustments and currencies, and reads every page', async () => {
    const p = ports();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          jobComplete: false,
          jobReference: { projectId: 'billing', jobId: 'query', location: 'US' },
        }),
      )
      .mockResolvedValueOnce(response({ jobComplete: true, rows: [row()], pageToken: 'next' }))
      .mockResolvedValueOnce(response({ jobComplete: true, rows: [row('EUR', '-2', '0', '-2')] }));
    p.fetch = request;
    const report = await readGoogleBilling(p, base, now);
    expect(report.lines.map((line) => [line.currency, line.net])).toEqual([
      ['USD', 7],
      ['EUR', -2],
    ]);
    expect(report.lines[0]?.credits).toBe(-3);
    expect(report.latestExportAt).toBe('2026-09-27T08:00:00.000Z');
    expect(request.mock.calls[2]?.[0]).toContain('pageToken=next');
    const body = JSON.parse(request.mock.calls[0]?.[1].body);
    expect(body.maximumBytesBilled).toBe('1000000000');
    expect(body.query).toContain('project.id = @project');
    expect(
      body.queryParameters.find((parameter: { name: string }) => parameter.name === 'project')
        .parameterValue.value,
    ).toBe('assistant');
  });

  it('does not report an empty export as zero spend', async () => {
    const p = ports();
    p.fetch = vi.fn(async () => response({ jobComplete: true }));
    const report = await readGoogleBilling(p, base, now);
    expect(report.status).toBe('unavailable');
    expect(report.lines).toEqual([]);
  });

  it('rejects unsafe identifiers and requires an explicit project scope', () => {
    const config = ports().config;
    expect(() =>
      googleBillingQuery({ ...config, GCP_BILLING_EXPORT_TABLE: 'p.d.t` UNION SELECT 1' }, now),
    ).toThrow();
    expect(() => googleBillingQuery({ ...config, GCP_PROJECT: '' }, now)).toThrow();
    expect(
      googleBillingQuery({ ...config, GCP_BILLING_SCOPE: 'billing_account' }, now).query,
    ).not.toContain('project.id = @project');
  });

  it('rejects missing money rather than converting null to zero', async () => {
    const p = ports();
    const invalid = row();
    invalid.f[5] = { v: '' };
    p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [invalid] }));
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('Invalid billing amount');
  });

  it('rejects an unfinished or failed query without publishing partial spend', async () => {
    const p = ports();
    p.fetch = vi.fn(async () =>
      response({ jobComplete: false, jobReference: { projectId: 'billing', jobId: 'slow' } }),
    );
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('incomplete');
    p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()], errors: [{}] }));
    await expect(readGoogleBilling(p, base, now)).rejects.toThrow('failed');
  });

  it('uses key-reported OpenRouter spend and does not add BYOK upstream costs', async () => {
    const report = await readOpenRouterBilling(
      vi.fn(async () => response({ data: { usage_monthly: 12, byok_usage_monthly: 100 } })),
      'secret',
      base,
      now,
    );
    expect(report.lines[0]?.net).toBe(12);
    expect(report.message).toContain('not added here');
    const zero = await readOpenRouterBilling(
      vi.fn(async () => response({ data: { usage_monthly: 0 } })),
      'secret',
      base,
      now,
    );
    expect(zero.lines[0]?.net).toBe(0);
    await expect(
      readOpenRouterBilling(
        vi.fn(async () => response({ data: {} })),
        'secret',
        base,
        now,
      ),
    ).rejects.toThrow();
  });

  it('caches successful snapshots and preserves stale spend after failure without leaking errors', async () => {
    const p = ports();
    const request = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
    p.fetch = request;
    expect((await getProviderBilling(p))[0]?.status).toBe('reported');
    await getProviderBilling(p);
    expect(request).toHaveBeenCalledTimes(1);
    p.now = () => new Date(now.getTime() + 3_600_001);
    request.mockRejectedValue(new Error('Authorization: secret-token'));
    const failed = await getProviderBilling(p);
    expect(failed[0]?.status).toBe('stale');
    expect(failed[0]?.lines[0]?.net).toBe(7);
    expect(failed[0]?.fetchedAt).toBe(now.toISOString());
    expect(JSON.stringify(failed)).not.toContain('secret-token');
    await getProviderBilling(p);
    expect(request).toHaveBeenCalledTimes(2);
    p.now = () => new Date('2026-10-01T00:00:00Z');
    const nextMonth = await getProviderBilling(p);
    expect(nextMonth[0]?.status).toBe('unavailable');
    expect(nextMonth[0]?.lines).toEqual([]);
  });

  it('serves the last snapshot instead of waiting out a slow provider refresh', async () => {
    const p = ports();
    const request = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
    p.fetch = request;
    expect((await getProviderBilling(p))[0]?.status).toBe('reported');

    // The hour is up and BigQuery is slow: the caller gets last hour's numbers
    // inside its budget, not whenever the query finishes.
    p.now = () => new Date(now.getTime() + 3_600_001);
    let finish: (value: Response) => void = () => {};
    request.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    p.refreshBudgetMs = 20;
    const started = Date.now();
    const meanwhile = await getProviderBilling(p);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(meanwhile[0]?.status).toBe('stale');
    expect(meanwhile[0]?.lines[0]?.net).toBe(7);
    expect(meanwhile[0]?.message).toContain('Refreshing');

    // The refresh was not abandoned: it lands in the cache for the next read.
    finish(response({ jobComplete: true, rows: [row('USD', '20', '-3', '17')] }));
    await vi.waitFor(async () => {
      p.refreshBudgetMs = undefined;
      expect((await getProviderBilling(p))[0]?.lines[0]?.net).toBe(17);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('says it is still loading when there is no snapshot to fall back on', async () => {
    const p = ports();
    p.fetch = vi.fn(() => new Promise<Response>(() => {}));
    p.refreshBudgetMs = 20;
    const [google] = await getProviderBilling(p);
    expect(google?.status).toBe('unavailable');
    expect(google?.lines).toEqual([]);
    expect(google?.message).toContain('still loading');
  });

  it('isolates billing scopes and surfaces newly connected providers without invented prices', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    vi.mocked(p.models.connections.list).mockResolvedValue([
      {
        id: 'my-gateway',
        kind: 'openai_compatible',
        label: 'My models',
        apiKeyEncrypted: null,
        baseUrl: 'https://models.example.test/v1',
        enabled: true,
        vertexLocation: null,
        vertexProject: null,
        lastTestedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const reports = await getProviderBilling(p);
    expect(reports.map((report) => report.status)).toEqual(['not_configured', 'unsupported']);
    expect(reports[1]?.lines).toEqual([]);
  });
});

it('keeps billing cache failures from taking down the ledger or triggering uncached cloud queries', async () => {
  const p = ports();
  p.cache.cacheGet = vi.fn(async () => {
    throw new Error('cache down');
  });
  p.fetch = vi.fn();
  const report = (await getProviderBilling(p))[0];
  expect(report?.status).toBe('unavailable');
  expect(p.fetch).not.toHaveBeenCalled();
});

it('reports model connection failures without hiding Google Cloud coverage', async () => {
  const p = ports();
  vi.mocked(p.models.connections.list).mockRejectedValue(
    new Error('credentials in error should not leak'),
  );
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  const reports = await getProviderBilling(p);
  expect(reports[0]?.status).toBe('reported');
  expect(reports[1]?.status).toBe('unavailable');
  expect(JSON.stringify(reports)).not.toContain('credentials in error');
});

it('flags a Vertex project outside the selected Google Cloud scope', async () => {
  const p = ports();
  p.config.GCP_BILLING_EXPORT_TABLE = '';
  p.models.config.VERTEX_PROJECT = 'other-project';
  const report = (await getProviderBilling(p)).find((report) => report.id === 'vertex');
  expect(report?.message).toContain('outside the selected Google Cloud billing scope');
});

it('does not reuse a snapshot when the selected Google Cloud scope changes', async () => {
  const p = ports();
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  await getProviderBilling(p);
  p.config.GCP_PROJECT = 'different-project';
  await getProviderBilling(p);
  expect(p.fetch).toHaveBeenCalledTimes(2);
});

describe('month-end run rate', () => {
  const report: ProviderBilling = {
    ...base,
    status: 'reported',
    latestUsageAt: '2026-09-16T00:00:00Z',
    fetchedAt: '2026-09-20T00:00:00Z',
    lines: [
      { service: 'Vertex AI', detail: '', currency: 'USD', cost: 40, credits: -10, net: 30 },
      { service: 'Cloud Run', detail: '', currency: 'EUR', cost: 15, credits: 0, net: 15 },
    ],
  };

  it('uses the Google usage horizon, credits and separate currencies', () => {
    const forecast = billingForecast(report);
    expect(forecast?.observedDays).toBe(15);
    expect(forecast?.totals).toEqual([
      { currency: 'USD', spent: 30, dailyAverage: 2, projected: 60 },
      { currency: 'EUR', spent: 15, dailyAverage: 1, projected: 30 },
    ]);
  });

  it('queries only the explicitly filtered OpenAI Costs scope and aggregates all daily pages', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key';
    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a, proj_b';
    p.config.OPENAI_BILLING_API_KEY_IDS = 'key_a';
    p.models.open = vi.fn(() => 'sk-admin-test-secretvalue');
    const bucket = (amount: number, currency = 'usd', day = 1) => ({
      object: 'bucket',
      start_time: Math.floor(Date.parse(`2026-09-0${day}T00:00:00Z`) / 1_000),
      end_time: Math.floor(Date.parse(`2026-09-0${day + 1}T00:00:00Z`) / 1_000),
      results: [
        {
          object: 'organization.costs.result',
          amount: { value: amount, currency },
          line_item: 'Text input',
          project_id: 'proj_a',
          api_key_id: 'key_a',
        },
      ],
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: [bucket(0.25)], has_more: true, next_page: 'cursor-1' }),
      )
      .mockResolvedValueOnce(
        response({ data: [bucket(0.75, 'usd', 2)], has_more: false, next_page: null }),
      );
    p.fetch = request;

    const report = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(report).toMatchObject({
      status: 'reported',
      periodTimezone: 'UTC',
      checkedAt: now.toISOString(),
      latestUsageAt: null,
      latestExportAt: null,
      lines: [
        {
          currency: 'USD',
          cost: 1,
          credits: 0,
          net: 1,
          projectId: 'proj_a',
          apiKeyId: 'key_a',
          detail: 'proj_a · key_a · Text input',
        },
      ],
    });
    expect(report?.message).toContain(
      'does not prove that every configured OpenAI connection is covered',
    );
    expect(report?.scope).toBe(
      'Configured organization scope · Projects: proj_a, proj_b; API keys: key_a',
    );
    expect(report?.amountBasis).toBe('provider_reported_cost');
    expect(report?.forecast).toBeUndefined();
    expect(report?.message).toContain(
      'Separate credits and net-after-credits amounts are not reported',
    );
    expect(request).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = request.mock.calls[0] as [string, RequestInit];
    const query = new URL(firstUrl).searchParams;
    expect(new URL(firstUrl).origin + new URL(firstUrl).pathname).toBe(
      'https://api.openai.com/v1/organization/costs',
    );
    expect(query.get('start_time')).toBe(
      String(Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1_000)),
    );
    expect(query.get('end_time')).toBe(String(Math.floor(now.getTime() / 1_000)));
    expect(query.getAll('group_by')).toEqual(['project_id', 'api_key_id', 'line_item']);
    expect(query.getAll('project_ids')).toEqual(['proj_a', 'proj_b']);
    expect(query.getAll('api_key_ids')).toEqual(['key_a']);
    expect(query.get('bucket_width')).toBe('1d');
    expect(query.get('limit')).toBe('31');
    expect(query.get('page')).toBeNull();
    expect(firstInit.headers).toEqual({ Authorization: 'Bearer sk-admin-test-secretvalue' });
    expect(new URL(request.mock.calls[1]?.[0] as string).searchParams.get('page')).toBe('cursor-1');
    expect(JSON.stringify(report)).not.toContain('sk-admin-test-secretvalue');
  });

  it('requires an explicit project or API-key filter and never uses the model connection host or key', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key';
    vi.mocked(p.models.connections.list).mockResolvedValue([
      {
        id: 'openai-models',
        kind: 'openai',
        label: 'OpenAI models',
        apiKeyEncrypted: 'model-key-sealed',
        baseUrl: 'https://custom-model-host.example/v1',
        enabled: true,
        vertexLocation: null,
        vertexProject: null,
        lastTestedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    p.models.open = vi.fn((sealed) =>
      sealed === 'sealed-admin-key' ? 'sk-admin-test-secretvalue' : 'model-api-secret',
    );
    const request = vi.fn();
    p.fetch = request;
    const missing = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(missing?.status).toBe('not_configured');
    expect(missing?.setup?.code).toBe('openai_scope_missing');
    expect(request).not.toHaveBeenCalled();

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a';
    request.mockResolvedValue(
      response({
        data: [
          {
            start_time: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1_000),
            end_time: Math.floor(Date.parse('2026-09-02T00:00:00Z') / 1_000),
            results: [
              {
                object: 'organization.costs.result',
                amount: { value: 1, currency: 'USD' },
                project_id: 'proj_a',
                api_key_id: null,
                line_item: 'Inference',
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );
    await getProviderBilling(p);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.openai.com/v1/organization/costs?');
    expect(url).not.toContain('custom-model-host');
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-admin-test-secretvalue' });
    expect(p.models.open).toHaveBeenCalledExactlyOnceWith('sealed-admin-key');
    expect(JSON.stringify(request.mock.calls)).not.toContain('model-api-secret');
  });

  it('fails closed on invalid scope, out-of-scope rows, null money, and repeated cursors', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key';
    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a';
    p.models.open = vi.fn(() => 'sk-admin-test-secretvalue');
    p.fetch = vi.fn(async () => response({ data: [], has_more: false, next_page: null }));
    const accidentalSecret = 'sk-admin-secretvalue';
    p.config.OPENAI_BILLING_PROJECT_IDS = `proj_a, ${accidentalSecret}`;
    p.config.OPENAI_BILLING_ACCOUNT_LABEL = accidentalSecret;
    const invalid = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(invalid?.status).toBe('not_configured');
    expect(invalid?.setup?.code).toBe('openai_scope_invalid');
    expect(p.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(invalid)).not.toContain(accidentalSecret);

    await expect(
      readOpenAIBilling(p.fetch ?? fetch, 'admin', base, now, [accidentalSecret], []),
    ).rejects.toThrow();
    await expect(
      readOpenAIBilling(p.fetch ?? fetch, 'sk-admin-validfakekey', base, now, ['proj_'], []),
    ).rejects.toThrow();

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_';
    p.config.OPENAI_BILLING_ACCOUNT_LABEL = '';
    const emptySuffix = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(emptySuffix?.setup?.code).toBe('openai_scope_invalid');
    expect(p.fetch).not.toHaveBeenCalled();

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a';
    const wrongScope = {
      data: [
        {
          start_time: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1_000),
          end_time: Math.floor(Date.parse('2026-09-02T00:00:00Z') / 1_000),
          results: [
            {
              object: 'organization.costs.result',
              amount: { value: 2, currency: 'usd' },
              project_id: 'proj_b',
              api_key_id: null,
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    p.fetch = vi.fn(async () => response(wrongScope));
    const mismatch = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(mismatch?.status).toBe('unavailable');
    expect(mismatch?.lines).toEqual([]);

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_c';
    const nullMoney = structuredClone(wrongScope);
    const nullMoneyResult = nullMoney.data[0]?.results[0];
    if (!nullMoneyResult) throw new Error('Missing billing test row');
    nullMoneyResult.project_id = 'proj_c';
    nullMoneyResult.amount.value = null as unknown as number;
    p.fetch = vi.fn(async () => response(nullMoney));
    const invalidMoney = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(invalidMoney?.status).toBe('unavailable');
    expect(invalidMoney?.lines).toEqual([]);

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_c';
    const excessiveMoney = structuredClone(wrongScope);
    const excessiveMoneyResult = excessiveMoney.data[0]?.results[0];
    if (!excessiveMoneyResult) throw new Error('Missing billing test row');
    excessiveMoneyResult.project_id = 'proj_c';
    excessiveMoneyResult.amount.value = Number.MAX_SAFE_INTEGER;
    p.fetch = vi.fn(async () => response(excessiveMoney));
    const excessive = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(excessive?.status).toBe('unavailable');
    expect(excessive?.lines).toEqual([]);

    const excessiveAggregate = structuredClone(wrongScope);
    const aggregateBucket = excessiveAggregate.data[0];
    const aggregateResult = aggregateBucket?.results[0];
    if (!aggregateBucket || !aggregateResult) throw new Error('Missing billing test row');
    aggregateResult.project_id = 'proj_c';
    aggregateResult.amount.value = Number.MAX_SAFE_INTEGER / 1_000_000;
    aggregateBucket.results.push(structuredClone(aggregateResult));
    p.fetch = vi.fn(async () => response(excessiveAggregate));
    const overflow = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(overflow?.status).toBe('unavailable');
    expect(overflow?.lines).toEqual([]);

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_d';
    p.fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [], has_more: true, next_page: 'repeat' }))
      .mockResolvedValueOnce(response({ data: [], has_more: true, next_page: 'repeat' }));
    const repeated = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(repeated?.status).toBe('unavailable');
    expect(repeated?.lines).toEqual([]);

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_e';
    const wrongObject = structuredClone(wrongScope);
    const wrongObjectResult = wrongObject.data[0]?.results[0];
    if (!wrongObjectResult) throw new Error('Missing billing test row');
    wrongObjectResult.project_id = 'proj_e';
    wrongObjectResult.object = 'organization.usage.completions.result';
    p.fetch = vi.fn(async () => response(wrongObject));
    const malformed = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(malformed?.status).toBe('unavailable');
    expect(malformed?.lines).toEqual([]);

    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_f';
    const duplicateBucket = structuredClone(wrongScope);
    const duplicateBucketResult = duplicateBucket.data[0]?.results[0];
    if (!duplicateBucketResult) throw new Error('Missing billing test row');
    duplicateBucketResult.project_id = 'proj_f';
    p.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: duplicateBucket.data, has_more: true, next_page: 'page-two' }),
      )
      .mockResolvedValueOnce(response(duplicateBucket));
    const overlap = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(overlap?.status).toBe('unavailable');
    expect(overlap?.lines).toEqual([]);
  });

  it('distinguishes currency-qualified zero from an empty response and preserves key rotation scope', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key-one';
    p.config.OPENAI_BILLING_API_KEY_IDS = 'key_a';
    p.models.open = vi.fn((sealed) =>
      sealed === 'sealed-admin-key-one' ? 'sk-admin-test-one' : 'sk-admin-test-two',
    );
    const zero = {
      data: [
        {
          start_time: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1_000),
          end_time: Math.floor(Date.parse('2026-09-02T00:00:00Z') / 1_000),
          results: [
            {
              object: 'organization.costs.result',
              amount: { value: 0, currency: 'USD' },
              api_key_id: 'key_a',
              line_item: 'Inference',
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    const request = vi.fn(async () => response(zero));
    p.fetch = request;
    const first = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(first?.status).toBe('reported');
    expect(first?.lines[0]?.net).toBe(0);

    p.config.OPENAI_BILLING_API_KEY_IDS = 'key_b';
    p.fetch = vi.fn(async () => response({ data: [], has_more: false, next_page: null }));
    const emptyResponse = (await getProviderBilling(p)).find(
      (item) => item.id === 'openai-billing',
    );
    expect(emptyResponse?.status).toBe('unavailable');
    expect(emptyResponse?.lines).toEqual([]);

    // Rotating the sealed credential changes the hashed cache identity.
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key-two';
    const rotatedKeyZero = structuredClone(zero);
    const rotatedKeyResult = rotatedKeyZero.data[0]?.results[0];
    if (!rotatedKeyResult) throw new Error('Missing billing test row');
    rotatedKeyResult.api_key_id = 'key_b';
    p.fetch = vi.fn(async () => response(rotatedKeyZero));
    await getProviderBilling(p);
    expect(p.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not infer per-connection OpenAI coverage and includes a single setup feed', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    vi.mocked(p.models.connections.list).mockResolvedValue([
      {
        id: 'openai-models',
        kind: 'openai',
        label: 'OpenAI models',
        apiKeyEncrypted: 'model-key-sealed',
        baseUrl: null,
        enabled: true,
        vertexLocation: null,
        vertexProject: null,
        lastTestedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    p.models.open = vi.fn((sealed) => sealed);
    const reports = await getProviderBilling(p);
    const feed = reports.find((item) => item.id === 'openai-billing');
    const connection = reports.find((item) => item.id === 'openai-models');
    expect(feed?.status).toBe('not_configured');
    expect(feed?.setup?.code).toBe('openai_admin_key_missing');
    expect(connection?.status).toBe('unavailable');
    expect(connection?.includedIn).toBeUndefined();
    expect(connection?.message).toContain('organization billing feed');
    expect(p.models.open).not.toHaveBeenCalled();
    expect(p.fetch).toBeUndefined();
    expect(JSON.stringify(reports)).not.toContain('model-key-sealed');
  });

  it('keeps OpenAI admin decryption failures and provider errors secret-safe', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'ciphertext-should-not-appear';
    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a';
    p.models.open = vi.fn(() => {
      throw new Error('secret plaintext should not appear');
    });
    p.fetch = vi.fn();
    const failedToOpen = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(failedToOpen?.status).toBe('unavailable');
    expect(failedToOpen?.setup?.code).toBe('openai_admin_key_unavailable');
    expect(p.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(failedToOpen)).not.toContain('ciphertext-should-not-appear');
    expect(JSON.stringify(failedToOpen)).not.toContain('secret plaintext');

    p.models.open = vi.fn(() => 'sk-proj-modelcredential');
    p.fetch = vi.fn();
    const wrongKeyType = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(wrongKeyType?.status).toBe('unavailable');
    expect(wrongKeyType?.setup?.code).toBe('openai_admin_key_unavailable');
    expect(p.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(wrongKeyType)).not.toContain('sk-proj-modelcredential');

    p.models.open = vi.fn(() => 'sk-admin-test-secretvalue');
    p.fetch = vi.fn(async () => new Response('credential leak body', { status: 403 }));
    const failedRequest = (await getProviderBilling(p)).find(
      (item) => item.id === 'openai-billing',
    );
    expect(failedRequest?.status).toBe('unavailable');
    expect(JSON.stringify(failedRequest)).not.toContain('sk-admin-test-secretvalue');
    expect(JSON.stringify(failedRequest)).not.toContain('credential leak body');
  });

  it('does not echo credential-shaped account labels into the billing feed', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-key';
    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_a';
    const accidentalSecret = 'sk-admin-secretvalue';
    p.config.OPENAI_BILLING_ACCOUNT_LABEL = accidentalSecret;
    p.models.open = vi.fn(() => 'sk-admin-test-secretvalue');
    p.fetch = vi.fn(async () => response({ data: [], has_more: false, next_page: null }));

    const report = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(report?.label).toBe('OpenAI organization');
    expect(report?.scope).toContain('Projects: proj_a');
    expect(JSON.stringify(report)).not.toContain(accidentalSecret);
  });

  it('returns actionable static GCP setup diagnostics without starting a query', async () => {
    const p = ports();
    p.fetch = vi.fn();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    const missing = (await getProviderBilling(p))[0];
    expect(missing?.status).toBe('not_configured');
    expect(missing?.setup?.code).toBe('google_billing_export_missing');
    expect(p.fetch).not.toHaveBeenCalled();

    p.config.GCP_BILLING_EXPORT_TABLE = 'project.dataset.table;DROP';
    const invalid = (await getProviderBilling(p))[0];
    expect(invalid?.status).toBe('unavailable');
    expect(invalid?.setup?.code).toBe('google_billing_export_table_invalid');
    expect(p.fetch).not.toHaveBeenCalled();

    p.config.GCP_BILLING_EXPORT_TABLE = 'billing.data.export';
    p.config.GCP_PROJECT = '';
    const missingProject = (await getProviderBilling(p))[0];
    expect(missingProject?.status).toBe('not_configured');
    expect(missingProject?.setup?.code).toBe('google_billing_project_missing');
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it('withholds estimates for stale, missing, early or wrong-month data', () => {
    for (const change of [
      { status: 'stale' as const },
      { latestUsageAt: null },
      { latestUsageAt: '2026-09-02T00:00:00Z' },
      { latestUsageAt: '2026-08-31T00:00:00Z' },
      { latestUsageAt: '2026-10-02T00:00:00Z' },
      { lines: [] },
    ])
      expect(billingForecast({ ...report, ...change })).toBeUndefined();
  });

  it('uses the provider fetch horizon and calendar month length including leap years', () => {
    const forecast = billingForecast({
      ...report,
      id: 'openrouter',
      period: '2024-02',
      fetchedAt: '2024-02-16T00:00:00Z',
    });
    expect(forecast?.daysInMonth).toBe(29);
    expect(forecast?.totals[0]?.projected).toBe(58);
  });
});

it('marks covered Vertex billing as included without duplicating Google charges', async () => {
  const p = ports();
  p.config.GCP_BILLING_SCOPE = 'billing_account';
  p.models.config.VERTEX_PROJECT = 'assistant';
  const vertexRow = row('USD', '0', '0', '0');
  vertexRow.f[2] = { v: 'Vertex AI' };
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [vertexRow] }));
  const reports = await getProviderBilling(p);
  const vertex = reports.find((report) => report.id === 'vertex');
  expect(vertex?.status).toBe('included');
  expect(vertex?.includedIn).toBe('google-cloud');
  expect(vertex?.lines).toEqual([]);
  expect(vertex?.forecast).toBeUndefined();
  expect(reports[0]?.lines[0]?.net).toBe(0);
});

it('does not infer zero or included Vertex coverage from a project export without a Vertex row', async () => {
  const p = ports();
  p.models.config.VERTEX_PROJECT = 'assistant';
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  const reports = await getProviderBilling(p);
  const vertex = reports.find((report) => report.id === 'vertex');
  expect(vertex?.status).toBe('unavailable');
  expect(vertex?.includedIn).toBeUndefined();
  expect(vertex?.message).toContain('does not establish zero Vertex cost');
});

it('does not infer Vertex coverage from an account export that lacks the project service row', async () => {
  const p = ports();
  p.config.GCP_BILLING_SCOPE = 'billing_account';
  p.models.config.VERTEX_PROJECT = 'assistant';
  p.fetch = vi.fn(async () => response({ jobComplete: true, rows: [row()] }));
  const vertex = (await getProviderBilling(p)).find((report) => report.id === 'vertex');
  expect(vertex?.status).toBe('unavailable');
  expect(vertex?.includedIn).toBeUndefined();
  expect(vertex?.message).toContain('does not contain a Vertex AI usage row');
});

it('projects partial coverage without calculating a whole-app total or merging overlapping sources', () => {
  const coverage = billingCoverageProjection([
    {
      ...base,
      status: 'reported',
      scope: 'Project: assistant',
      message: 'Exported usage.',
      lines: [
        {
          service: 'Cloud Run',
          detail: 'assistant · cpu',
          currency: 'USD',
          cost: 1,
          credits: 0,
          net: 1,
        },
      ],
    },
    {
      ...base,
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'reported',
      scope: 'Connection: OpenRouter',
      message: 'Connected key.',
      lines: [
        {
          service: 'OpenRouter',
          detail: 'Current API key',
          currency: 'USD',
          cost: 2,
          credits: 0,
          net: 2,
        },
      ],
    },
    {
      ...base,
      id: 'custom',
      label: 'Custom provider',
      status: 'unsupported',
      scope: 'Connection: Custom',
      message: 'Ledger estimates only.',
      lines: [],
    },
    {
      ...base,
      id: 'vertex',
      label: 'Google Vertex AI',
      status: 'unavailable',
      scope: 'Connection: Google Vertex AI',
      message: 'No Vertex row.',
      lines: [],
    },
    {
      ...base,
      id: 'openai-billing',
      label: 'OpenAI organization',
      status: 'reported',
      scope: 'Projects: proj_a; API keys: key_a',
      source: 'OpenAI Costs API',
      message:
        'OpenAI Costs API amounts for the selected project and API-key filters. This organization feed does not prove that every configured OpenAI connection is covered.',
      lines: [],
    },
  ]);
  expect(coverage.totalState).toBe('unavailable');
  expect(coverage.title).toBe('Whole-app total unavailable');
  expect(coverage.statusSummary).toContain('Google Vertex AI unavailable');
  expect(coverage.statusSummary).toContain('Custom provider unsupported');
  expect(coverage.statusSummary).not.toContain('Phone calls');
  expect(coverage.entries.find((item) => item.id === 'google-cloud')).toMatchObject({
    state: 'partial',
    scope: 'Project: assistant',
    period: '2026-09',
    source: 'test',
    detail: expect.stringContaining('some taxes and adjustments'),
  });
  expect(coverage.entries.find((item) => item.id === 'openrouter')).toMatchObject({
    state: 'partial',
    scope: 'Connection: OpenRouter',
  });
  expect(coverage.entries.find((item) => item.id === 'direct-model-providers')).toMatchObject({
    label: 'Unverified model-provider coverage',
    detail: expect.stringContaining('does not prove every model connection is covered'),
  });
  expect(coverage.entries.find((item) => item.id === 'vertex')?.state).toBe('unknown');
  expect(coverage.entries.find((item) => item.id === 'custom')?.state).toBe('ledger_only');
  expect(coverage.entries.find((item) => item.id === 'assistant-ledger')?.state).toBe(
    'overlapping',
  );
  expect(
    coverage.entries.some((item) => item.id === 'other-services' && item.state === 'not_imported'),
  ).toBe(true);
  expect(JSON.stringify(coverage)).not.toContain('3.00');
});

it('summarizes current missing and stale providers without using hypothetical gaps', () => {
  const coverage = billingCoverageProjection([
    { ...base, label: 'Google Cloud', status: 'stale', message: 'Export delayed.', lines: [] },
    {
      ...base,
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'not_configured',
      message: 'No key connected.',
      lines: [],
    },
  ]);

  expect(coverage.statusSummary).toBe(
    'Current feeds: Google Cloud stale; OpenRouter not configured. Missing costs remain unknown, not zero.',
  );
  expect(coverage.statusSummary).not.toContain('Phone calls');
});

describe('mobile amount-only billing compatibility', () => {
  const amountOnly: ProviderBilling = {
    ...base,
    id: 'openai-billing',
    label: 'OpenAI organization',
    status: 'reported',
    amountBasis: 'provider_reported_cost',
    message: 'Provider-reported cost for the selected project.',
    forecast: {
      through: '2026-09-16',
      observedDays: 15,
      daysInMonth: 30,
      totals: [{ currency: 'USD', spent: 1.25, dailyAverage: 0.08, projected: 2.5 }],
      message: 'Observed-period run rate only.',
    },
    lines: [
      {
        service: 'OpenAI',
        detail: 'proj_demo · Text input',
        currency: 'USD',
        cost: 1.25,
        credits: 0,
        net: 1.25,
        projectId: 'proj_demo',
      },
    ],
  };
  const legacyReport: ProviderBilling = {
    ...base,
    id: 'openrouter',
    label: 'OpenRouter',
    status: 'reported',
    lines: [
      {
        service: 'OpenRouter',
        detail: 'Model usage',
        currency: 'USD',
        cost: 0.4,
        credits: 0,
        net: 0.4,
      },
    ],
  };

  it('keeps amount-only numbers and forecast away from clients without exact capability support', () => {
    const projected = projectBillingForMobile([amountOnly, legacyReport], false);

    expect(projected[0]).toMatchObject({
      id: 'openai-billing',
      status: 'unavailable',
      amountBasis: 'provider_reported_cost',
      lines: [],
      message: expect.stringContaining('Update the app to view the reported-cost breakdown.'),
    });
    expect(projected[0]?.forecast).toBeUndefined();
    expect(JSON.stringify(projected[0])).not.toContain('1.25');
    expect(projected[1]).toEqual(legacyReport);
  });

  it('leaves reports untouched when the client explicitly supports amount-only billing', () => {
    const reports = [amountOnly, legacyReport];
    expect(projectBillingForMobile(reports, true)).toBe(reports);
  });
});
