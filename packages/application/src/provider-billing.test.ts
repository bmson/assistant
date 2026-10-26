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
    expect(report.amountBasis).toBe('provider_reported_cost');
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

  it('projects amount-only reported cost without claiming an after-credits amount', () => {
    const forecast = billingForecast({
      ...report,
      id: 'openrouter',
      amountBasis: 'provider_reported_cost',
      period: '2026-09',
      fetchedAt: '2026-09-16T00:00:00Z',
      lines: [
        { service: 'OpenRouter', detail: '', currency: 'USD', cost: 30, credits: 0, net: 99 },
      ],
    });
    expect(forecast?.totals).toEqual([
      { currency: 'USD', spent: 30, dailyAverage: 2, projected: 60 },
    ]);
    expect(forecast?.message).toContain('reported cost');
    expect(forecast?.message).toContain('does not report credits');
    expect(forecast?.message).not.toContain('after credits');
  });
});

describe('OpenAI organization Costs adapter', () => {
  it('opens only the dedicated sealed admin credential and will not query without explicit filters', async () => {
    const p = ports();
    p.config.GCP_BILLING_EXPORT_TABLE = '';
    p.config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED = 'sealed-admin-fixture';
    p.models.open = vi.fn((sealed) =>
      sealed === 'sealed-admin-fixture' ? 'sk-admin-fixturevalue' : 'sk-project-modelvalue',
    );
    p.fetch = vi.fn(async () => response({ data: [], has_more: false, next_page: null }));
    const missing = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(missing).toMatchObject({
      status: 'not_configured',
      setup: { code: 'openai_scope_missing' },
    });
    expect(p.fetch).not.toHaveBeenCalled();
    p.config.OPENAI_BILLING_PROJECT_IDS = 'proj_fixture';
    const start = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1_000);
    const end = Math.floor(Date.parse('2026-09-02T00:00:00Z') / 1_000);
    vi.mocked(p.fetch).mockResolvedValue(
      response({
        data: [
          {
            start_time: start,
            end_time: end,
            results: [
              {
                object: 'organization.costs.result',
                amount: { value: 0, currency: 'USD' },
                project_id: 'proj_fixture',
                api_key_id: null,
                line_item: 'Input',
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );
    const report = (await getProviderBilling(p)).find((item) => item.id === 'openai-billing');
    expect(report).toMatchObject({
      status: 'reported',
      amountBasis: 'provider_reported_cost',
      lines: [{ cost: 0 }],
    });
    expect(p.models.open).toHaveBeenCalledExactlyOnceWith('sealed-admin-fixture');
    expect(JSON.stringify(report)).not.toContain('sk-admin-fixturevalue');
    expect(JSON.stringify(report)).not.toContain('sk-project-modelvalue');
  });

  it('uses explicit filters and complete cursor pages, preserving amount-only scope', async () => {
    const bucket = (day: number, value: number) => ({
      object: 'bucket',
      start_time: Math.floor(
        Date.parse(`2026-09-${String(day).padStart(2, '0')}T00:00:00Z`) / 1000,
      ),
      end_time: Math.floor(
        Date.parse(`2026-09-${String(day + 1).padStart(2, '0')}T00:00:00Z`) / 1000,
      ),
      results: [
        {
          object: 'organization.costs.result',
          amount: { value, currency: 'usd' },
          line_item: 'Input tokens',
          project_id: 'proj_a',
          api_key_id: 'key_a',
        },
      ],
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: [bucket(1, 0.125)], has_more: true, next_page: 'next' }),
      )
      .mockResolvedValueOnce(
        response({ data: [bucket(2, 0.375)], has_more: false, next_page: null }),
      );
    const result = await readOpenAIBilling(
      request,
      'sk-admin-testsecret',
      base,
      now,
      ['proj_a'],
      ['key_a'],
    );
    expect(result).toMatchObject({
      status: 'reported',
      amountBasis: 'provider_reported_cost',
      latestUsageAt: null,
      lines: [
        {
          cost: 0.5,
          credits: 0,
          net: 0.5,
          currency: 'USD',
          projectId: 'proj_a',
          apiKeyId: 'key_a',
        },
      ],
    });
    const [firstUrl, firstInit] = request.mock.calls[0] as [string, RequestInit];
    const params = new URL(firstUrl).searchParams;
    expect(new URL(firstUrl).origin + new URL(firstUrl).pathname).toBe(
      'https://api.openai.com/v1/organization/costs',
    );
    expect(params.getAll('project_ids')).toEqual(['proj_a']);
    expect(params.getAll('api_key_ids')).toEqual(['key_a']);
    expect(params.getAll('group_by')).toEqual(['project_id', 'api_key_id', 'line_item']);
    expect(params.get('bucket_width')).toBe('1d');
    expect(params.get('page')).toBeNull();
    expect(firstInit.headers).toEqual({ Authorization: 'Bearer sk-admin-testsecret' });
    expect(new URL(request.mock.calls[1]?.[0] as string).searchParams.get('page')).toBe('next');
    expect(result.message).toContain('credits and net-after-credits amounts are not reported');
    expect(billingForecast(result)).toBeUndefined();
  });

  it('rejects missing scope, invalid identity rows, repeated cursors, and empty results as unknown', async () => {
    await expect(
      readOpenAIBilling(vi.fn(), 'sk-admin-testsecret', base, now, [], []),
    ).rejects.toThrow();
    const wrongScope = vi.fn(async () =>
      response({
        data: [
          {
            start_time: 1798761600,
            end_time: 1798848000,
            results: [
              {
                object: 'organization.costs.result',
                amount: { value: 1, currency: 'USD' },
                project_id: 'proj_other',
                api_key_id: null,
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );
    await expect(
      readOpenAIBilling(wrongScope, 'sk-admin-testsecret', base, now, ['proj_a'], []),
    ).rejects.toThrow();
    const repeated = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [], has_more: true, next_page: 'same' }))
      .mockResolvedValueOnce(response({ data: [], has_more: true, next_page: 'same' }));
    await expect(
      readOpenAIBilling(repeated, 'sk-admin-testsecret', base, now, ['proj_a'], []),
    ).rejects.toThrow();
    const empty = await readOpenAIBilling(
      vi.fn(async () => response({ data: [], has_more: false, next_page: null })),
      'sk-admin-testsecret',
      base,
      now,
      ['proj_a'],
      [],
    );
    expect(empty.status).toBe('unavailable');
    expect(empty.lines).toEqual([]);
  });

  it('hides amount-only lines from old mobile clients and keeps supported reports intact', () => {
    const amountOnly = {
      ...base,
      id: 'openai-billing',
      amountBasis: 'provider_reported_cost' as const,
      status: 'reported' as const,
      lines: [
        { service: 'OpenAI', detail: 'proj_a', currency: 'USD', cost: 1, credits: 0, net: 1 },
      ],
    };
    expect(projectBillingForMobile([amountOnly], false)[0]).toMatchObject({
      status: 'unavailable',
      lines: [],
    });
    expect(projectBillingForMobile([amountOnly], false)[0]?.message).toContain(
      'Update the app to view the reported-cost breakdown.',
    );
    expect(projectBillingForMobile([amountOnly], true)[0]).toBe(amountOnly);
  });

  it('keeps the actual OpenRouter amount-only report unavailable to older mobile clients', async () => {
    const request = vi.fn(async () => response({ data: { usage_monthly: 12 } }));
    const report = await readOpenRouterBilling(
      request,
      'fixture-key',
      { ...base, id: 'openrouter' },
      now,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      id: 'openrouter',
      status: 'reported',
      amountBasis: 'provider_reported_cost',
      lines: [{ service: 'OpenRouter', cost: 12, credits: 0, net: 12 }],
    });
    const newerClient = projectBillingForMobile([report], true)[0];
    expect(newerClient).toBe(report);
    expect(newerClient?.amountBasis).toBe('provider_reported_cost');
    const olderClient = projectBillingForMobile([report], false)[0];
    expect(olderClient).toMatchObject({ status: 'unavailable', lines: [], forecast: undefined });
    expect(olderClient?.amountBasis).toBe('provider_reported_cost');
    expect(olderClient?.message).toContain('Update the app to view the reported-cost breakdown.');
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

function ledgerEntry(
  rows?: Parameters<typeof billingCoverageProjection>[1],
  reports: ProviderBilling[] = [],
) {
  const projection = billingCoverageProjection(reports, rows);
  expect(projection.totalState).toBe('unavailable');
  expect(projection.title).toBe('Whole-app total unavailable');
  const entry = projection.entries.find((value) => value.id === 'assistant-ledger');
  if (!entry?.ledgerEvidence) throw new Error('Missing ledger evidence projection');
  return entry;
}

it.each([{ rows: undefined }, { rows: null }, { rows: [] }])(
  'keeps absent or empty evidence unknown without inferring zero or no activity ($rows)',
  ({ rows }) => {
    const entry = ledgerEntry(rows);
    expect(entry.ledgerEvidence?.groups).toEqual([]);
    expect(entry.ledgerEvidence?.emptyMessage).toContain(
      'does not establish zero spending or no activity',
    );
    expect(entry.ledgerEvidence?.metadata).toContain('freshness are not supplied');
    expect(entry.ledgerEvidence?.metadata).toMatch(/^Ledger aggregation in USD\./);
    expect(entry.ledgerEvidence?.metadata).not.toContain('Monthly');
    expect(entry.period).toBeUndefined();
    expect(entry.source).toBeUndefined();
  },
);

it('preserves each mixed evidence basis, exact USD representation and event count without an aggregate', () => {
  const rows = [
    { basis: 'provider_reported' as const, usd: '1.250000', count: 2 },
    { basis: 'token_rate' as const, usd: '0.000003', count: 3 },
    { basis: 'preflight_estimate' as const, usd: '2.5000', count: 4 },
    { basis: 'component_ledger' as const, usd: '3.125', count: 5 },
    { basis: 'unknown' as const, usd: '4.000000', count: 6 },
  ];
  const entry = ledgerEntry(rows);
  expect(entry.ledgerEvidence?.currency).toBe('USD');
  expect(
    entry.ledgerEvidence?.groups.map((group) => ({ basis: group.basis, ...group.rows[0] })),
  ).toEqual(rows.map((row) => ({ ...row, id: expect.any(String) })));
  expect(entry.ledgerEvidence?.groups.map((group) => group.label)).toEqual([
    'Provider-reported operation receipts',
    'Token-rate estimates',
    'Preflight estimates',
    'Mixed reported and estimated components',
    'Unverified ledger records',
  ]);
  expect(Object.keys(entry.ledgerEvidence ?? {})).not.toContain('total');
  expect(entry.detail).toContain('not account invoices');
});

it('keeps duplicate basis groups separate with stable unique keys and no subtotal', () => {
  const rows = [
    { basis: 'unknown' as const, usd: '1.00', count: 2 },
    { basis: 'unknown' as const, usd: '3.00', count: 4 },
    { basis: 'unknown' as const, usd: '1.00', count: 2 },
  ];
  const first = ledgerEntry(rows).ledgerEvidence?.groups[0]?.rows ?? [];
  const reordered = ledgerEntry([...rows].reverse()).ledgerEvidence?.groups[0]?.rows;
  expect(first).toEqual(reordered);
  expect(first).toHaveLength(3);
  expect(new Set(first.map((row) => row.id)).size).toBe(3);
  expect(first.map(({ usd, count }) => ({ usd, count }))).toEqual([
    { usd: '1.00', count: 2 },
    { usd: '1.00', count: 2 },
    { usd: '3.00', count: 4 },
  ]);
});

it('preserves explicit zero and safe amount/count under unrecognized basis while malformed fields remain unknown', () => {
  const rows = [
    { basis: 'provider_reported', usd: '0.000000', count: 1 },
    { basis: 'unexpected_basis', usd: '9.125000', count: 7 },
    { basis: 'token_rate', usd: 'NaN', count: 2 },
    { basis: 'preflight_estimate', usd: 'Infinity', count: Number.POSITIVE_INFINITY },
    { basis: 'component_ledger', usd: null, count: undefined },
  ] as unknown as NonNullable<Parameters<typeof billingCoverageProjection>[1]>;
  const groups = ledgerEntry(rows).ledgerEvidence?.groups ?? [];
  expect(groups.find((group) => group.basis === 'provider_reported')?.rows[0]).toMatchObject({
    usd: '0.000000',
    count: 1,
  });
  expect(groups.find((group) => group.basis === 'unknown')).toMatchObject({
    label: 'Unverified ledger records',
    rows: [expect.objectContaining({ usd: '9.125000', count: 7 })],
  });
  expect(groups.find((group) => group.basis === 'token_rate')?.rows[0]).toMatchObject({
    usd: null,
    count: 2,
  });
  expect(groups.find((group) => group.basis === 'preflight_estimate')?.rows[0]).toMatchObject({
    usd: null,
    count: null,
  });
  expect(groups.find((group) => group.basis === 'component_ledger')?.rows[0]).toMatchObject({
    usd: null,
    count: null,
  });
});

it('retains provider period/scope and stale or missing Vertex state without inventing metadata for ledger groups', () => {
  const reports: ProviderBilling[] = [
    {
      ...base,
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'stale',
      period: '2026-10',
      scope: 'Shared saved key',
      message: 'Includes unrelated usage; not assistant-only.',
      lines: [],
    },
    {
      ...base,
      id: 'vertex',
      label: 'Google Vertex AI',
      status: 'unavailable',
      message: 'No matching project row.',
      lines: [],
    },
  ];
  const projection = billingCoverageProjection(reports, [
    { basis: 'provider_reported', usd: '2.00', count: 1 },
  ]);
  expect(projection.entries.find((entry) => entry.id === 'openrouter')).toMatchObject({
    state: 'stale',
    period: '2026-10',
    scope: 'Shared saved key',
    detail: 'Includes unrelated usage; not assistant-only.',
  });
  expect(projection.entries.find((entry) => entry.id === 'vertex')?.state).toBe('unknown');
  const ledger = ledgerEntry([{ basis: 'provider_reported', usd: '2.00', count: 1 }], reports);
  expect(ledger.period).toBeUndefined();
  expect(ledger.scope).toContain('attribution unverified');
  expect(ledger.ledgerEvidence?.metadata).toContain(
    'Exact period boundaries, source/account scope and freshness are not supplied',
  );
});

it('projects equivalent PostgreSQL and Firestore DTO shapes without reading or combining held liability', () => {
  // Both existing readers expose basis/usd/count. No adapter/database execution is implied.
  const postgres = {
    byEvidence: [{ basis: 'provider_reported' as const, usd: '0.000000', count: 1 }],
    held: [
      {
        id: 'held',
        estimatedUsd: '987.654321',
        source: 'unknown',
        description: 'Unverified liability',
      },
    ],
  };
  const firestore = {
    byEvidence: [{ basis: 'provider_reported' as const, usd: '0.000000', count: 1 }],
    held: [...postgres.held],
  };
  expect(billingCoverageProjection([], postgres.byEvidence)).toEqual(
    billingCoverageProjection([], firestore.byEvidence),
  );
  const projected = JSON.stringify(billingCoverageProjection([], postgres.byEvidence));
  expect(projected).not.toContain('987.654321');
  expect(postgres.held).toEqual(firestore.held);
  expect(ledgerEntry(undefined).ledgerEvidence?.groups).toEqual([]); // unavailable upstream shape
  expect(ledgerEntry([]).ledgerEvidence?.groups).toEqual([]);
});

it('keeps a paired same-provider report and operation receipt overlapping rather than summing the two views', () => {
  // The synthetic fixture establishes this overlap; byEvidence itself supplies no provider attribution.
  const report: ProviderBilling = {
    ...base,
    id: 'openrouter',
    label: 'OpenRouter',
    status: 'reported',
    period: '2026-10',
    scope: 'Shared saved key',
    message: 'Key usage includes unrelated use.',
    lines: [
      {
        service: 'OpenRouter',
        detail: 'Saved-key usage',
        currency: 'USD',
        cost: 2.5,
        credits: 0,
        net: 2.5,
      },
    ],
  };
  const projection = billingCoverageProjection(
    [report],
    [{ basis: 'provider_reported', usd: '2.500000', count: 1 }],
  );
  expect(projection.overlapWarning).toContain('overlap provider bills');
  expect(projection.totalState).toBe('unavailable');
  expect(projection.entries.find((entry) => entry.id === 'openrouter')?.scope).toBe(
    'Shared saved key',
  );
  expect(
    ledgerEntry([{ basis: 'provider_reported', usd: '2.500000', count: 1 }]).ledgerEvidence
      ?.groups[0]?.rows[0]?.usd,
  ).toBe('2.500000');
  expect(Object.hasOwn(projection, 'totalUsd')).toBe(false);
});
