import { createHash } from 'node:crypto';
import type { Config } from '@assistant/config';
import type { CostBasis, CostEvidenceTotal, ToolExecutionRepository } from '@assistant/persistence';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { ModelProviderPorts } from './model-providers.js';

export interface BillingLine {
  service: string;
  detail: string;
  currency: string;
  cost: number;
  credits: number;
  net: number;
  projectId?: string;
  apiKeyId?: string;
}

/** Provider statements and the operation ledger overlap. Never add them together. */
export interface ProviderBilling {
  id: string;
  label: string;
  status: 'reported' | 'unavailable' | 'stale' | 'not_configured' | 'unsupported' | 'included';
  period: string;
  scope: string;
  source: string;
  message: string;
  fetchedAt: string | null;
  /** Time the provider feed was checked, including a failed refresh attempt. */
  checkedAt?: string | null;
  /** Timezone used for the reporting period boundaries. */
  periodTimezone?: 'UTC';
  /** Amount-only sources do not report a separate credit or net-after-credits breakdown. */
  amountBasis?: 'provider_reported_cost';
  /** Safe, actionable configuration guidance; never includes credential values. */
  setup?: { code: string; steps: string[] };
  latestExportAt: string | null;
  latestUsageAt: string | null;
  lines: BillingLine[];
  includedIn?: string;
  forecast?: BillingForecast;
}

/** Older mobile clients cannot represent an unreported credit/net breakdown without inventing zeros. */
export function projectBillingForMobile(
  reports: ProviderBilling[],
  supportsAmountOnly: boolean,
): ProviderBilling[] {
  if (supportsAmountOnly) return reports;
  return reports.map((report) =>
    report.amountBasis === 'provider_reported_cost'
      ? {
          ...report,
          status: 'unavailable' as const,
          lines: [],
          forecast: undefined,
          message: `${report.message} Update the app to view the reported-cost breakdown.`,
        }
      : report,
  );
}

export type BillingCoverageState =
  | 'partial'
  | 'included'
  | 'stale'
  | 'not_configured'
  | 'unsupported'
  | 'ledger_only'
  | 'not_imported'
  | 'overlapping'
  | 'unknown';

export interface LedgerEvidenceGroup {
  basis: CostBasis;
  label: string;
  rows: Array<{ id: string; usd: string | null; count: number | null }>;
}

/** Existing USD event groups, not account coverage, invoices or held liability. */
export interface LedgerEvidenceCoverage {
  currency: 'USD';
  metadata: string;
  emptyMessage: string;
  groups: LedgerEvidenceGroup[];
}

const LEDGER_EVIDENCE_LABELS: Record<CostBasis, string> = {
  provider_reported: 'Provider-reported operation receipts',
  token_rate: 'Token-rate estimates',
  preflight_estimate: 'Preflight estimates',
  component_ledger: 'Mixed reported and estimated components',
  unknown: 'Unverified ledger records',
};

function ledgerEvidenceCoverage(
  rows?: readonly CostEvidenceTotal[] | null,
): LedgerEvidenceCoverage {
  const groups = new Map<CostBasis, Array<{ usd: string | null; count: number | null }>>();
  for (const value of Array.isArray(rows) ? rows : []) {
    const row = value as Partial<CostEvidenceTotal> | null;
    const basisValue = row?.basis;
    const validBasis =
      typeof basisValue === 'string' && Object.hasOwn(LEDGER_EVIDENCE_LABELS, basisValue);
    const basis: CostBasis = validBasis ? (basisValue as CostBasis) : 'unknown';
    const usd =
      typeof row?.usd === 'string' &&
      /^-?\d+(?:\.\d+)?$/.test(row.usd) &&
      Number.isFinite(Number(row.usd))
        ? row.usd
        : null;
    const count =
      typeof row?.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 0
        ? row.count
        : null;
    const existing = groups.get(basis) ?? [];
    existing.push({ usd, count });
    groups.set(basis, existing);
  }
  return {
    currency: 'USD',
    metadata: [
      'Ledger aggregation in USD. Exact period boundaries, source/account scope and freshness are not supplied; coverage remains unverified.',
      'Recorded amounts do not verify a provider bill.',
      'Held reservations and unknown liability are separate from these recorded-event groups.',
    ].join(' '),
    emptyMessage:
      'Ledger evidence is unavailable or not supplied. Empty evidence does not establish zero spending or no activity.',
    groups: (Object.keys(LEDGER_EVIDENCE_LABELS) as CostBasis[]).flatMap((basis) => {
      const values = groups.get(basis);
      if (!values) return [];
      const ordered = values
        .slice()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const occurrences = new Map<string, number>();
      return [
        {
          basis,
          label: LEDGER_EVIDENCE_LABELS[basis],
          rows: ordered.map((row) => {
            const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
            const occurrence = occurrences.get(digest) ?? 0;
            occurrences.set(digest, occurrence + 1);
            return { id: `${basis}:${digest}:${occurrence}`, ...row };
          }),
        },
      ];
    }),
  };
}

export interface BillingCoverageEntry {
  id: string;
  label: string;
  state: BillingCoverageState;
  scope: string;
  detail: string;
  period?: string;
  source?: string;
  ledgerEvidence?: LedgerEvidenceCoverage;
}

/** A source inventory, never a combined spend total. */
export interface BillingCoverageProjection {
  totalState: 'unavailable';
  title: 'Whole-app total unavailable';
  summary: string;
  statusSummary?: string;
  overlapWarning: string;
  entries: BillingCoverageEntry[];
}

export function billingCoverageProjection(
  reports: ProviderBilling[],
  evidence?: readonly CostEvidenceTotal[] | null,
): BillingCoverageProjection {
  const attentionStatuses = reports
    .filter((report) => report.status !== 'reported' && report.status !== 'included')
    .map((report) => {
      const status =
        report.status === 'not_configured'
          ? 'not configured'
          : report.status === 'stale'
            ? 'stale'
            : report.status === 'unsupported'
              ? 'unsupported'
              : 'unavailable';
      return `${report.label} ${status}`;
    });
  const entries: BillingCoverageEntry[] = reports.map((report) => {
    let state: BillingCoverageState;
    if (report.id === 'vertex') {
      if (report.includedIn === 'google-cloud') {
        state = report.status === 'stale' ? 'stale' : 'included';
      } else {
        state = report.status === 'not_configured' ? 'not_configured' : 'unknown';
      }
    } else if (report.status === 'included') {
      state = 'included';
    } else if (report.status === 'reported') {
      state = 'partial';
    } else if (report.status === 'stale') {
      state = 'stale';
    } else if (report.status === 'not_configured') {
      state = 'not_configured';
    } else if (report.status === 'unsupported') {
      state = 'ledger_only';
    } else {
      state = 'unknown';
    }
    const scopeWarning =
      report.id === 'google-cloud' && report.scope.startsWith('Project: ')
        ? ' Project scope can exclude unallocated account charges, including some taxes and adjustments.'
        : '';
    return {
      id: report.id,
      label: report.label,
      state,
      scope: report.scope,
      detail: `${report.message}${scopeWarning}`,
      period: report.period,
      source: report.source,
    };
  });

  entries.push(
    {
      id: 'assistant-ledger',
      label: 'Assistant usage ledger',
      state: 'overlapping',
      scope: 'Assistant operation ledger; account attribution unverified',
      ledgerEvidence: ledgerEvidenceCoverage(evidence),
      detail: [
        'Includes provider-reported operation receipts and configured-rate estimates used for assistant caps, not account invoices.',
        'It can overlap provider charges and must stay separate; assistant limits do not cap cloud or provider bills.',
      ].join(' '),
    },
    {
      id: 'voice-calls',
      label: 'Phone calls (if used)',
      state: 'partial',
      scope: 'Call ledger and Twilio connectivity receipts',
      detail: [
        'When phone calls are used, Twilio call prices cover connectivity only.',
        'Media, model, transcription and answer-detection components may be estimates or unknown,',
        'and shared runtime is not attributed to each call.',
      ].join(' '),
    },
    {
      id: 'direct-model-providers',
      label: 'Unverified model-provider coverage',
      state: 'ledger_only',
      scope: 'Selected OpenAI organization scope and custom provider gateways',
      detail: [
        'The OpenAI organization Costs feed reports only its selected project and API-key filters; it does not prove every model connection is covered.',
        'Custom provider gateway invoices are not imported. The usage ledger records provider-reported amounts when available and configured-rate estimates otherwise; those can overlap provider bills.',
      ].join(' '),
    },
    {
      id: 'search-maps',
      label: 'Search and maps (if used)',
      state: 'not_imported',
      scope: 'External provider accounts',
      detail: [
        'When these services are used, provider invoices are not imported here.',
        'Tool-ledger amounts, when present, are configured estimates; Google Cloud costs appear only when they are in the selected export scope.',
      ].join(' '),
    },
    {
      id: 'other-services',
      label: 'Other accounts and services (if configured or used)',
      state: 'not_imported',
      scope: 'External accounts or unselected cloud scopes',
      detail: [
        'If used, email and SMS, Apple push and developer services, Workspace seats, external CI and other vendor accounts are not imported here.',
        'Google Cloud storage and runtime costs appear only when they are in the selected export scope.',
        'Missing costs are unknown, not zero.',
      ].join(' '),
    },
  );

  return {
    totalState: 'unavailable',
    title: 'Whole-app total unavailable',
    summary: [
      'The sources below cover different accounts, projects and usage.',
      'Their amounts are not combined, and missing coverage is unknown rather than zero.',
    ].join(' '),
    ...(attentionStatuses.length > 0
      ? {
          statusSummary: `Current feeds: ${attentionStatuses.join('; ')}. Missing costs remain unknown, not zero.`,
        }
      : {}),
    overlapWarning: [
      'Assistant usage-ledger amounts may overlap provider bills.',
      'Keep them separate; assistant spending limits do not cap provider or cloud bills.',
    ].join(' '),
    entries,
  };
}

export interface BillingForecast {
  through: string;
  observedDays: number;
  daysInMonth: number;
  totals: Array<{ currency: string; spent: number; dailyAverage: number; projected: number }>;
  message: string;
}

/** A transparent run rate, never an invoice prediction or an extrapolated stale snapshot. */
export function billingForecast(report: ProviderBilling): BillingForecast | undefined {
  if (report.status !== 'reported' || !report.lines.length) return;
  const through =
    report.id === 'google-cloud' || report.id === 'openai-billing'
      ? report.latestUsageAt
      : report.fetchedAt;
  if (!through || !/^\d{4}-\d{2}$/.test(report.period)) return;
  const start = Date.parse(`${report.period}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const observedDays = (Date.parse(through) - start) / 86_400_000;
  const daysInMonth = (end.getTime() - start) / 86_400_000;
  if (!Number.isFinite(observedDays) || observedDays < 3 || observedDays > daysInMonth) return;
  const amounts = new Map<string, number>();
  for (const line of report.lines)
    amounts.set(
      line.currency,
      (amounts.get(line.currency) ?? 0) +
        (report.amountBasis === 'provider_reported_cost' ? line.cost : line.net),
    );
  return {
    through,
    observedDays,
    daysInMonth,
    totals: [...amounts].map(([currency, spent]) => ({
      currency,
      spent,
      dailyAverage: spent / observedDays,
      projected: (spent / observedDays) * daysInMonth,
    })),
    message:
      report.amountBasis === 'provider_reported_cost'
        ? 'Month-end run-rate estimate at the observed average daily reported cost. This source does not report credits or net-after-credits amounts. Assumes this feed covers the month from day one and usage stays similar. Delayed charges and changing usage can change the result.'
        : 'Month-end estimate at the observed average daily spend, after credits. Assumes this export covers the month from day one and usage stays similar. Delayed charges, changing usage and one-off credits can change the result.',
  };
}

export type BillingConfig = Pick<
  Config,
  | 'GCP_PROJECT'
  | 'GCP_BILLING_EXPORT_TABLE'
  | 'GCP_BILLING_QUERY_PROJECT'
  | 'GCP_BILLING_LOCATION'
  | 'GCP_BILLING_SCOPE'
  | 'GCP_BILLING_MAX_BYTES'
> &
  Partial<{
    OPENAI_BILLING_ADMIN_KEY_ENCRYPTED: string;
    OPENAI_BILLING_PROJECT_IDS: string;
    OPENAI_BILLING_API_KEY_IDS: string;
    OPENAI_BILLING_ACCOUNT_LABEL: string;
  }>;
export type BillingCache = Pick<ToolExecutionRepository, 'cacheGet' | 'cachePut'>;
export interface BillingPorts {
  models: ModelProviderPorts;
  config: BillingConfig;
  cache: BillingCache;
  fetch?: typeof fetch;
  accessToken?: () => Promise<string>;
  now?: () => Date;
  /**
   * How long a caller will wait on a provider refresh before settling for the
   * last snapshot. A cached report is served at once; this bounds the miss.
   * The refresh itself keeps running and lands in the cache for the next read,
   * so a slow provider costs one stale answer instead of a stalled screen.
   * Unset waits for the provider, which is what a background job wants.
   */
  refreshBudgetMs?: number;
}

const HOUR = 3_600_000;
const RETRY = 300_000;
const RETENTION = 7 * 24 * HOUR;
// Do not share a pending response across installation-specific repositories.
const requests = new WeakMap<BillingCache, Map<string, Promise<ProviderBilling>>>();

function empty(
  id: string,
  label: string,
  period: string,
  scope: string,
  source: string,
): ProviderBilling {
  return {
    id,
    label,
    period,
    scope,
    source,
    status: 'unavailable',
    message: '',
    fetchedAt: null,
    checkedAt: null,
    periodTimezone: 'UTC',
    latestExportAt: null,
    latestUsageAt: null,
    lines: [],
  };
}

interface CachedBilling {
  checkedAt: string;
  report: ProviderBilling;
}

/** Durable, scope/credential/version-keyed snapshots prevent a query on every mobile refresh. */
async function cached(
  ports: BillingPorts,
  base: ProviderBilling,
  identity: unknown,
  load: () => Promise<ProviderBilling>,
): Promise<ProviderBilling> {
  const now = (ports.now ?? (() => new Date()))();
  const key = `provider-billing:v1:${createHash('sha256')
    .update(JSON.stringify([base.period, identity]))
    .digest('hex')}`;
  let saved: CachedBilling | undefined;
  try {
    saved = (await ports.cache.cacheGet(key, now))?.result as CachedBilling | undefined;
  } catch {
    // Do not start potentially billable queries when their cache is unavailable.
    return {
      ...base,
      message: 'Billing snapshots are temporarily unavailable. The usage ledger remains separate.',
    };
  }
  if (saved?.report?.period === base.period && Number.isFinite(Date.parse(saved.checkedAt))) {
    const age = now.getTime() - Date.parse(saved.checkedAt);
    if (age >= 0 && age < (saved.report.status === 'reported' ? HOUR : RETRY)) return saved.report;
  }
  let pendingForStore = requests.get(ports.cache);
  if (!pendingForStore) {
    pendingForStore = new Map();
    requests.set(ports.cache, pendingForStore);
  }
  const existing = pendingForStore.get(key);
  // Reports from the snapshot already in hand, for a caller that will not wait.
  const whileRefreshing = (): ProviderBilling => {
    const previous =
      saved?.report?.period === base.period && saved.report.fetchedAt ? saved.report : null;
    return previous
      ? {
          ...previous,
          status: 'stale',
          message: 'Refreshing from the provider. Showing the last snapshot.',
        }
      : {
          ...base,
          status: 'unavailable',
          message: 'Provider data is still loading. Check again in a moment.',
        };
  };
  if (existing) return withinBudget(existing, ports.refreshBudgetMs, whileRefreshing);
  const run = async () => {
    let report: ProviderBilling;
    try {
      report = await load();
      report = { ...report, checkedAt: now.toISOString() };
    } catch {
      // Never forward HTTP/auth errors: they may contain a request credential.
      const previous =
        saved?.report?.period === base.period && saved.report.fetchedAt ? saved.report : null;
      report = previous
        ? {
            ...previous,
            status: 'stale',
            checkedAt: now.toISOString(),
            message:
              'Refresh failed. Showing the last successful provider snapshot; check credentials, permissions and export settings.',
          }
        : {
            ...base,
            status: 'unavailable',
            checkedAt: now.toISOString(),
            message:
              'Provider data could not be loaded. Check credentials, permissions and export settings. Missing spend is not zero.',
          };
    }
    try {
      await ports.cache.cachePut({
        cacheKey: key,
        toolName: 'billing.snapshot',
        result: { checkedAt: now.toISOString(), report },
        expiresAt: new Date(now.getTime() + RETENTION),
      });
    } catch {
      report = { ...report, message: `${report.message} This snapshot could not be saved.` };
    }
    return report;
  };
  const pending = run().finally(() => pendingForStore.delete(key));
  pendingForStore.set(key, pending);
  return withinBudget(pending, ports.refreshBudgetMs, whileRefreshing);
}

/** Resolve with `fallback()` if `pending` takes longer than `budgetMs`; never rejects on its behalf. */
function withinBudget(
  pending: Promise<ProviderBilling>,
  budgetMs: number | undefined,
  fallback: () => ProviderBilling,
): Promise<ProviderBilling> {
  if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs < 0) return pending;
  return new Promise<ProviderBilling>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), budgetMs);
    pending.then(
      (report) => {
        clearTimeout(timer);
        resolve(report);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function json(request: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(url, {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Billing HTTP ${response.status}`);
  return response.json();
}

const openrouterKey = z.object({
  data: z.object({
    usage_monthly: z.number().finite().nonnegative(),
    byok_usage_monthly: z.number().finite().nonnegative().optional(),
  }),
});

const BILLING_AMOUNT_LIMIT = Number.MAX_SAFE_INTEGER / 1_000_000;
const openAICostResult = z.object({
  object: z.literal('organization.costs.result'),
  amount: z.object({
    value: z.number().finite().min(-BILLING_AMOUNT_LIMIT).max(BILLING_AMOUNT_LIMIT),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
  }),
  line_item: z.string().max(256).nullable().optional(),
  project_id: z.string().max(128).nullable().optional(),
  api_key_id: z.string().max(128).nullable().optional(),
});
const openAICostPage = z.object({
  data: z.array(
    z.object({
      object: z.literal('bucket').optional(),
      start_time: z.number().finite().int(),
      end_time: z.number().finite().int(),
      results: z.array(openAICostResult),
    }),
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable().optional(),
});
const OPENAI_BILLING_PAGE_LIMIT = 32;
const OPENAI_BILLING_RESULT_LIMIT = 20_000;

function validateIds(values: string[], prefix: 'proj_' | 'key_'): string[] {
  const ids = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (
    ids.length > 25 ||
    ids.some(
      (id) =>
        !id.startsWith(prefix) ||
        id.length <= prefix.length ||
        id.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(id),
    )
  )
    throw new Error('Invalid OpenAI billing filter');
  return ids;
}

function configuredIds(value: string, prefix: 'proj_' | 'key_'): string[] {
  return validateIds(value.split(','), prefix);
}

function safeOpenAIAccountLabel(value: string | undefined): string {
  const label = (value ?? '').trim().slice(0, 80);
  return /\bsk[-_][A-Za-z0-9_-]{8,}/i.test(label) ? '' : label;
}

function isOpenAIAdminKey(value: string): boolean {
  return /^sk-admin-[A-Za-z0-9_-]{8,512}$/.test(value.trim());
}

/** Fetches only official organization Costs data inside an explicitly selected project/key scope. */
export async function readOpenAIBilling(
  request: typeof fetch,
  adminKey: string,
  base: ProviderBilling,
  now: Date,
  projectIds: string[],
  apiKeyIds: string[],
): Promise<ProviderBilling> {
  if (!isOpenAIAdminKey(adminKey)) throw new Error('Invalid OpenAI billing credential');
  adminKey = adminKey.trim();
  projectIds = validateIds(projectIds, 'proj_');
  apiKeyIds = validateIds(apiKeyIds, 'key_');
  if (!projectIds.length && !apiKeyIds.length) throw new Error('Missing OpenAI billing scope');
  const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1_000);
  const end = Math.floor(now.getTime() / 1_000);
  if (!Number.isFinite(end) || end < start) throw new Error('Invalid OpenAI billing period');
  const grouped = new Map<
    string,
    {
      projectId?: string;
      apiKeyId?: string;
      lineItem: string;
      currency: string;
      amount: number;
    }
  >();
  const seenCursors = new Set<string>();
  const seenBuckets: Array<{ start: number; end: number }> = [];
  let cursor: string | undefined;
  let resultCount = 0;
  for (let pageIndex = 0; pageIndex < OPENAI_BILLING_PAGE_LIMIT; pageIndex++) {
    const query = new URLSearchParams({
      start_time: String(start),
      end_time: String(end),
      bucket_width: '1d',
      limit: '31',
    });
    for (const field of ['project_id', 'api_key_id', 'line_item']) query.append('group_by', field);
    for (const projectId of projectIds) query.append('project_ids', projectId);
    for (const apiKeyId of apiKeyIds) query.append('api_key_ids', apiKeyId);
    if (cursor) query.set('page', cursor);
    const page = openAICostPage.parse(
      await json(request, `https://api.openai.com/v1/organization/costs?${query}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      }),
    );
    if (page.data.length > 31) throw new Error('OpenAI billing page exceeds its result limit');
    for (const bucket of page.data) {
      if (
        bucket.start_time < start ||
        bucket.start_time >= end ||
        bucket.end_time <= bucket.start_time
      )
        throw new Error('OpenAI billing bucket is outside the selected period');
      if (seenBuckets.some((item) => bucket.start_time < item.end && bucket.end_time > item.start))
        throw new Error('OpenAI billing pages contain overlapping buckets');
      seenBuckets.push({ start: bucket.start_time, end: bucket.end_time });
      for (const result of bucket.results) {
        if (++resultCount > OPENAI_BILLING_RESULT_LIMIT)
          throw new Error('OpenAI billing result limit exceeded');
        const projectId = result.project_id ?? undefined;
        const apiKeyId = result.api_key_id ?? undefined;
        if (
          (projectIds.length && (!projectId || !projectIds.includes(projectId))) ||
          (apiKeyIds.length && (!apiKeyId || !apiKeyIds.includes(apiKeyId)))
        )
          throw new Error('OpenAI billing row is outside the selected scope');
        const lineItem = result.line_item?.trim() || 'Unclassified cost';
        const key = JSON.stringify([
          projectId ?? null,
          apiKeyId ?? null,
          lineItem,
          result.amount.currency.toUpperCase(),
        ]);
        const existing = grouped.get(key);
        if (existing) {
          existing.amount += result.amount.value;
          if (!Number.isFinite(existing.amount) || Math.abs(existing.amount) > BILLING_AMOUNT_LIMIT)
            throw new Error('OpenAI billing amount overflow');
        } else
          grouped.set(key, {
            ...(projectId ? { projectId } : {}),
            ...(apiKeyId ? { apiKeyId } : {}),
            lineItem,
            currency: result.amount.currency.toUpperCase(),
            amount: result.amount.value,
          });
      }
    }
    if (!page.has_more) {
      const lines: BillingLine[] = [...grouped.values()].map((row) => ({
        service: 'OpenAI',
        detail: [row.projectId, row.apiKeyId, row.lineItem].filter(Boolean).join(' · '),
        currency: row.currency,
        cost: row.amount,
        credits: 0,
        net: row.amount,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.apiKeyId ? { apiKeyId: row.apiKeyId } : {}),
      }));
      return {
        ...base,
        status: lines.length ? 'reported' : 'unavailable',
        fetchedAt: now.toISOString(),
        checkedAt: now.toISOString(),
        amountBasis: 'provider_reported_cost',
        latestExportAt: null,
        latestUsageAt: null,
        lines,
        message: lines.length
          ? 'OpenAI reported usage cost for the selected project and API-key filters, grouped by line item, for this UTC month. Separate credits and net-after-credits amounts are not reported. This organization feed does not prove that every configured OpenAI connection is covered.'
          : 'The selected OpenAI Costs scope returned no priced rows for this UTC month. Spend is unavailable, not zero.',
      };
    }
    if (!page.next_page?.trim() || seenCursors.has(page.next_page))
      throw new Error('OpenAI billing pagination is incomplete');
    seenCursors.add(page.next_page);
    cursor = page.next_page;
  }
  throw new Error('OpenAI billing results exceed the supported page limit');
}

function googleBillingSetup(config: BillingConfig): ProviderBilling['setup'] | undefined {
  if (!config.GCP_BILLING_EXPORT_TABLE)
    return {
      code: 'google_billing_export_missing',
      steps: [
        'Create a Google Cloud Billing BigQuery export.',
        'Set the export table and grant the web service query and dataset read access.',
      ],
    };
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(config.GCP_BILLING_EXPORT_TABLE))
    return {
      code: 'google_billing_export_table_invalid',
      steps: ['Set the export table as project.dataset.table using valid BigQuery identifiers.'],
    };
  if (config.GCP_BILLING_SCOPE === 'project' && !config.GCP_PROJECT)
    return {
      code: 'google_billing_project_missing',
      steps: ['Set the Google Cloud project used as the billing filter or choose account scope.'],
    };
}

export async function readOpenRouterBilling(
  request: typeof fetch,
  apiKey: string,
  base: ProviderBilling,
  now: Date,
): Promise<ProviderBilling> {
  const { data } = openrouterKey.parse(
    await json(request, 'https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  );
  return {
    ...base,
    status: 'reported',
    fetchedAt: now.toISOString(),
    message: `Spend reported for the connected API key, including use outside this assistant. Credit purchases and other keys are excluded.${data.byok_usage_monthly ? ' BYOK upstream usage is billed separately by that provider and is not added here.' : ''}`,
    amountBasis: 'provider_reported_cost',
    lines: [
      {
        service: 'OpenRouter',
        detail: 'Current API key · month to date',
        currency: 'USD',
        cost: data.usage_monthly,
        credits: 0,
        net: data.usage_monthly,
      },
    ],
  };
}

const queryPage = z.object({
  jobComplete: z.boolean(),
  jobReference: z
    .object({ projectId: z.string(), jobId: z.string(), location: z.string().optional() })
    .optional(),
  pageToken: z.string().optional(),
  errors: z.array(z.unknown()).optional(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.unknown() })) })).optional(),
});

/** Parameterized values; identifiers are validated before entering SQL. No service-name allowlist. */
export function googleBillingQuery(config: BillingConfig, now: Date) {
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(config.GCP_BILLING_EXPORT_TABLE))
    throw new Error('Invalid Cloud Billing export table');
  if (config.GCP_BILLING_SCOPE === 'project' && !config.GCP_PROJECT)
    throw new Error('Missing billing project scope');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const parameters = [
    {
      name: 'start',
      parameterType: { type: 'TIMESTAMP' },
      parameterValue: { value: start.toISOString() },
    },
    {
      name: 'end',
      parameterType: { type: 'TIMESTAMP' },
      parameterValue: { value: now.toISOString() },
    },
    ...(config.GCP_BILLING_SCOPE === 'project'
      ? [
          {
            name: 'project',
            parameterType: { type: 'STRING' },
            parameterValue: { value: config.GCP_PROJECT },
          },
        ]
      : []),
  ];
  return {
    query: `SELECT currency, COALESCE(project.id, '(unallocated)'), service.description, sku.description, cost_type,
      CAST(SUM(CAST(cost AS NUMERIC)) AS STRING),
      CAST(SUM(IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0)) AS STRING),
      CAST(SUM(CAST(cost AS NUMERIC) + IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0)) AS STRING),
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(export_time), 'UTC'),
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(usage_end_time), 'UTC')
      FROM \`${config.GCP_BILLING_EXPORT_TABLE}\`
      WHERE usage_start_time >= @start AND usage_start_time < @end
      ${config.GCP_BILLING_SCOPE === 'project' ? 'AND project.id = @project' : ''}
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: parameters,
    maximumBytesBilled: String(config.GCP_BILLING_MAX_BYTES),
    location: config.GCP_BILLING_LOCATION,
    timeoutMs: 10_000,
    maxResults: 1_000,
  };
}

function amount(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new Error('Invalid billing amount');
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > BILLING_AMOUNT_LIMIT)
    throw new Error('Billing amount overflow');
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid billing timestamp');
  return new Date(value).toISOString();
}

export async function readGoogleBilling(
  ports: BillingPorts,
  base: ProviderBilling,
  now: Date,
): Promise<ProviderBilling> {
  const config = ports.config;
  const body = googleBillingQuery(config, now);
  const token = await (
    ports.accessToken ??
    (async () => {
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/bigquery'] });
      const token = await auth.getAccessToken();
      if (!token) throw new Error('No Google credentials');
      return token;
    })
  )();
  const project = config.GCP_BILLING_QUERY_PROJECT || config.GCP_BILLING_EXPORT_TABLE.split('.')[0];
  const root = 'https://bigquery.googleapis.com/bigquery/v2/projects';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = ports.fetch ?? fetch;
  let page = queryPage.parse(
    await json(request, `${root}/${encodeURIComponent(project ?? '')}/queries`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const lines: BillingLine[] = [];
  let latestExportAt: string | null = null;
  let latestUsageAt: string | null = null;
  // Bounded polling and pagination: incomplete results are an error, never a partial total.
  for (let index = 0; index < 50; index++) {
    if (page.errors?.length) throw new Error('Billing query failed');
    if (page.jobComplete) {
      for (const row of page.rows ?? []) {
        const cells = row.f.map((cell) => cell.v);
        if (
          cells.length !== 10 ||
          typeof cells[0] !== 'string' ||
          !/^[A-Z]{3}$/.test(cells[0]) ||
          typeof cells[1] !== 'string'
        )
          throw new Error('Invalid billing row');
        lines.push({
          currency: cells[0],
          service: String(cells[2] ?? 'Other'),
          detail: `${cells[1]} · ${cells[3] ?? 'Other'} · ${cells[4] ?? 'regular'}`,
          cost: amount(cells[5]),
          credits: amount(cells[6]),
          net: amount(cells[7]),
          projectId: cells[1],
        });
        const exported = timestamp(cells[8]);
        const used = timestamp(cells[9]);
        if (!latestExportAt || exported > latestExportAt) latestExportAt = exported;
        if (!latestUsageAt || used > latestUsageAt) latestUsageAt = used;
      }
      if (!page.pageToken)
        return {
          ...base,
          status: lines.length ? 'reported' : 'unavailable',
          fetchedAt: now.toISOString(),
          latestExportAt,
          latestUsageAt,
          lines,
          message: lines.length
            ? 'Exported usage this UTC month, after credits. Reporting is delayed and may be corrected; this is not a final invoice. Latest usage is not a completeness guarantee.'
            : 'No exported usage for this period and scope yet. Spend is unavailable, not zero.',
        };
    }
    if (!page.jobReference || (!page.jobComplete && index >= 2))
      throw new Error('Billing query incomplete');
    const job = page.jobReference;
    const params = new URLSearchParams({
      location: job.location ?? config.GCP_BILLING_LOCATION,
      timeoutMs: '1000',
      maxResults: '1000',
      ...(page.pageToken ? { pageToken: page.pageToken } : {}),
    });
    const next = queryPage.parse(
      await json(
        request,
        `${root}/${encodeURIComponent(job.projectId)}/queries/${encodeURIComponent(job.jobId)}?${params}`,
        { headers },
      ),
    );
    page = { ...next, jobReference: next.jobReference ?? job };
  }
  throw new Error('Billing results exceed the supported page limit');
}

/** Adding a connected provider automatically exposes its billing coverage, even without a billing API. */
export async function getProviderBilling(ports: BillingPorts): Promise<ProviderBilling[]> {
  const now = (ports.now ?? (() => new Date()))();
  const period = now.toISOString().slice(0, 7);
  let connections: Awaited<ReturnType<ModelProviderPorts['connections']['list']>> = [];
  let connectionsUnavailable = false;
  try {
    connections = [...(await ports.models.connections.list())];
  } catch {
    connectionsUnavailable = true;
  }
  const config = ports.config;
  const base = empty(
    'google-cloud',
    'Google Cloud',
    period,
    config.GCP_BILLING_SCOPE === 'project'
      ? `Project: ${config.GCP_PROJECT || 'not configured'}`
      : 'Billing export account (all projects)',
    'Google Cloud Billing export',
  );
  const googleSetup = googleBillingSetup(config);
  const google = googleSetup
    ? Promise.resolve({
        ...base,
        status:
          googleSetup.code === 'google_billing_export_missing' ||
          googleSetup.code === 'google_billing_project_missing'
            ? ('not_configured' as const)
            : ('unavailable' as const),
        setup: googleSetup,
        message:
          'Google Cloud billing export setup is incomplete. Missing spend is unknown, not zero.',
      })
    : cached(
        ports,
        base,
        [
          'google',
          config.GCP_PROJECT,
          config.GCP_BILLING_EXPORT_TABLE,
          config.GCP_BILLING_QUERY_PROJECT,
          config.GCP_BILLING_LOCATION,
          config.GCP_BILLING_SCOPE,
          config.GCP_BILLING_MAX_BYTES,
        ],
        () => readGoogleBilling(ports, base, now),
      );

  const openAIBillingFieldsPresent = Boolean(
    config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED ||
      config.OPENAI_BILLING_PROJECT_IDS ||
      config.OPENAI_BILLING_API_KEY_IDS ||
      config.OPENAI_BILLING_ACCOUNT_LABEL,
  );
  const openAIBillingBase = (): ProviderBilling => {
    const accountLabel = safeOpenAIAccountLabel(config.OPENAI_BILLING_ACCOUNT_LABEL);
    const projectIds = (() => {
      try {
        return configuredIds(config.OPENAI_BILLING_PROJECT_IDS ?? '', 'proj_');
      } catch {
        return [];
      }
    })();
    const apiKeyIds = (() => {
      try {
        return configuredIds(config.OPENAI_BILLING_API_KEY_IDS ?? '', 'key_');
      } catch {
        return [];
      }
    })();
    const filterDescription = [
      projectIds.length ? `Projects: ${projectIds.join(', ')}` : '',
      apiKeyIds.length ? `API keys: ${apiKeyIds.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return empty(
      'openai-billing',
      accountLabel ? `OpenAI · ${accountLabel}` : 'OpenAI organization',
      period,
      filterDescription
        ? `Configured organization scope · ${filterDescription}`
        : 'Organization scope not selected',
      'OpenAI Costs API',
    );
  };
  const openAIBilling = (hasOpenAIConnection: boolean): Promise<ProviderBilling> => {
    if (!openAIBillingFieldsPresent && !hasOpenAIConnection)
      return Promise.resolve(openAIBillingBase());
    const report = openAIBillingBase();
    const setupResult = (
      code: string,
      steps: string[],
      status: ProviderBilling['status'] = 'not_configured',
    ) => ({
      ...report,
      status,
      setup: { code, steps },
      message:
        'OpenAI organization spend is not reported until the selected project or API-key scope and billing credential are configured. OpenAI connection costs remain unknown, not zero.',
    });
    const encryptedKey = config.OPENAI_BILLING_ADMIN_KEY_ENCRYPTED;
    if (!encryptedKey)
      return Promise.resolve(
        setupResult('openai_admin_key_missing', [
          'Configure a dedicated OpenAI organization admin key for billing; do not reuse a model API key.',
          'Set one or more OpenAI project IDs or API-key IDs to define the billing scope.',
        ]),
      );
    let projectIds: string[];
    let apiKeyIds: string[];
    try {
      projectIds = configuredIds(config.OPENAI_BILLING_PROJECT_IDS ?? '', 'proj_');
      apiKeyIds = configuredIds(config.OPENAI_BILLING_API_KEY_IDS ?? '', 'key_');
    } catch {
      return Promise.resolve(
        setupResult('openai_scope_invalid', [
          'Use comma-separated OpenAI project IDs and/or API-key IDs containing only letters, numbers, underscores, or hyphens.',
        ]),
      );
    }
    if (!projectIds.length && !apiKeyIds.length)
      return Promise.resolve(
        setupResult('openai_scope_missing', [
          'Set one or more OpenAI project IDs or API-key IDs; unfiltered organization-wide costs are not queried.',
        ]),
      );
    let adminKey: string;
    try {
      adminKey = ports.models.open(encryptedKey);
    } catch {
      return Promise.resolve(
        setupResult(
          'openai_admin_key_unavailable',
          ['Re-enter the dedicated OpenAI organization admin billing key in server configuration.'],
          'unavailable',
        ),
      );
    }
    if (!isOpenAIAdminKey(adminKey))
      return Promise.resolve(
        setupResult(
          'openai_admin_key_unavailable',
          ['Re-enter the dedicated OpenAI organization admin billing key in server configuration.'],
          'unavailable',
        ),
      );
    return cached(
      ports,
      report,
      [
        'openai-costs-v1',
        adminKey,
        projectIds,
        apiKeyIds,
        config.OPENAI_BILLING_ACCOUNT_LABEL ?? '',
      ],
      () => readOpenAIBilling(ports.fetch ?? fetch, adminKey, report, now, projectIds, apiKeyIds),
    );
  };
  if (connectionsUnavailable)
    return [
      await google,
      {
        ...empty(
          'model-providers',
          'Model providers',
          period,
          'Connected providers',
          'Provider connections',
        ),
        message: 'Model provider connections could not be loaded. Billing coverage is unavailable.',
      },
      ...(openAIBillingFieldsPresent ? [await openAIBilling(false)] : []),
    ];
  if (
    !connections.some((row) => row.id === 'openrouter') &&
    ports.models.config.LLM_PROVIDER !== 'vertex'
  ) {
    connections.push({
      id: 'openrouter',
      kind: 'openrouter',
      label: 'OpenRouter',
      apiKeyEncrypted: null,
      baseUrl: null,
      vertexProject: null,
      vertexLocation: null,
      enabled: true,
      lastTestedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!connections.some((row) => row.id === 'vertex') && ports.models.config.VERTEX_PROJECT) {
    connections.push({
      id: 'vertex',
      kind: 'vertex',
      label: 'Google Vertex AI',
      apiKeyEncrypted: null,
      baseUrl: null,
      vertexProject: ports.models.config.VERTEX_PROJECT,
      vertexLocation: ports.models.config.VERTEX_LOCATION,
      enabled: true,
      lastTestedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const googleReport = await google;
  const hasOpenAIConnection = connections.some((connection) => connection.kind === 'openai');
  const openAIReport =
    openAIBillingFieldsPresent || hasOpenAIConnection
      ? await openAIBilling(hasOpenAIConnection)
      : null;
  const reports = connections.map(async (connection) => {
    const report = empty(
      connection.id,
      connection.label,
      period,
      `Connection: ${connection.label}`,
      connection.kind,
    );
    if (connection.kind === 'vertex') {
      const project = connection.vertexProject || ports.models.config.VERTEX_PROJECT;
      const vertexUsageReported =
        Boolean(project) &&
        googleReport.lines.some(
          (line) => line.projectId === project && /\bvertex\b/i.test(line.service),
        );
      const available = vertexUsageReported && ['reported', 'stale'].includes(googleReport.status);
      const status = available
        ? googleReport.status === 'stale'
          ? ('stale' as const)
          : ('included' as const)
        : ('unavailable' as const);
      let message: string;
      if (project && config.GCP_BILLING_SCOPE === 'project' && project !== config.GCP_PROJECT) {
        message = `Vertex uses project ${project}, outside the selected Google Cloud billing scope. Its costs are not included above.`;
      } else if (available) {
        message = [
          `A Vertex AI usage row for project ${project} is present in the Google Cloud export above.`,
          'No separate Vertex amount is added. Model-level token costs below remain estimates.',
        ].join(' ');
      } else if (googleReport.status === 'reported' || googleReport.status === 'stale') {
        message = [
          `The Google Cloud export does not contain a Vertex AI usage row for project ${project || '(project not configured)'}.`,
          'This does not establish zero Vertex cost or complete service coverage.',
        ].join(' ');
      } else {
        message =
          'Google Cloud billing data is unavailable for checking Vertex project coverage. Missing Vertex spend is unknown, not zero.';
      }
      return {
        ...report,
        status,
        ...(available ? { includedIn: 'google-cloud' } : {}),
        message,
      };
    }
    if (connection.kind !== 'openrouter')
      return {
        ...report,
        status: 'unsupported' as const,
        message:
          connection.kind === 'openai'
            ? 'No per-connection billing connector. The separate OpenAI organization feed covers only its selected filters and does not prove this connection is included.'
            : 'No billing connector for this provider yet. Calls are tracked in the usage ledger; configured prices are estimates, not a provider bill.',
      };
    let key: string;
    try {
      key = connection.apiKeyEncrypted
        ? ports.models.open(connection.apiKeyEncrypted)
        : ports.models.config.OPENROUTER_API_KEY;
    } catch {
      return { ...report, message: 'The saved billing credential could not be opened.' };
    }
    if (!key)
      return {
        ...report,
        status: 'not_configured' as const,
        message: 'Connect an OpenRouter API key in AI providers to read its reported spend.',
      };
    return cached(ports, report, ['openrouter', connection.id, connection.label, key], () =>
      readOpenRouterBilling(ports.fetch ?? fetch, key, report, now),
    );
  });
  const result = await Promise.all([
    googleReport,
    ...reports,
    ...(openAIReport ? [openAIReport] : []),
  ]);
  return result.map((report) => ({ ...report, forecast: billingForecast(report) }));
}
