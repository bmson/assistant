import type {
  BillingCoverageProjection,
  BillingCoverageState,
  ProviderBilling,
} from '@assistant/application/provider-billing';
import { cardShellClass } from '@/lib/ui';

function money(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 8 : 2,
  }).format(value);
}

function billingTimestamp(label: string, value: string | null | undefined) {
  if (!value) return `${label}: time not reported`;
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasExplicitZone) return `${label}: ${value} (timezone not provided)`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return `${label}: ${value} (timestamp unrecognized)`;
  const formatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed);
  return `${label}: ${formatted} UTC`;
}

export function ProviderBillingCards({ reports }: { reports: ProviderBilling[] }) {
  return (
    <section className="mt-8 space-y-4" aria-label="Provider billing">
      <div>
        <h2 className="text-lg font-semibold">Provider billing</h2>
        <p className="mt-1 text-sm text-muted">
          Source-scoped usage and per-source run rates in their original currencies. Vertex is
          included only when a matching project usage row is present in the Google Cloud export.
        </p>
      </div>
      {reports.map((report) => {
        const totals = new Map<string, number>();
        const services = new Map<
          string,
          {
            service: string;
            detail: string;
            currency: string;
            projectId?: string;
            apiKeyId?: string;
            cost: number;
            net: number;
            credits: number;
          }
        >();
        for (const line of report.lines) {
          totals.set(line.currency, (totals.get(line.currency) ?? 0) + line.net);
          const key = JSON.stringify([
            line.service,
            line.detail,
            line.currency,
            line.projectId ?? null,
            line.apiKeyId ?? null,
          ]);
          const aggregate = services.get(key) ?? {
            service: line.service,
            detail: line.detail,
            currency: line.currency,
            projectId: line.projectId,
            apiKeyId: line.apiKeyId,
            cost: 0,
            net: 0,
            credits: 0,
          };
          aggregate.cost += line.cost;
          aggregate.net += line.net;
          aggregate.credits += line.credits;
          services.set(key, aggregate);
        }
        const statusLabel =
          report.status === 'reported'
            ? 'Reported'
            : report.status === 'included'
              ? 'Included'
              : report.status === 'stale'
                ? 'Stale'
                : report.status === 'not_configured'
                  ? 'Setup needed'
                  : report.status === 'unsupported'
                    ? 'Unsupported'
                    : 'Unavailable';
        return (
          <article key={report.id} className={`${cardShellClass} p-4`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">{report.label}</h3>
              <span className="text-sm font-medium text-muted">
                {statusLabel}
                {' · '}
                <span className="tabular-nums">
                  {totals.size
                    ? [...totals].map(([currency, total]) => money(total, currency)).join(' · ')
                    : report.includedIn
                      ? 'In Google Cloud report'
                      : 'No amount reported'}
                </span>
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {report.scope} · {report.period}
              {` · ${report.periodTimezone ? `${report.periodTimezone} period` : 'period timezone not reported'}`}{' '}
              · {report.source}
            </p>
            <p className="mt-3 text-sm text-muted">{report.message}</p>
            <p className="mt-2 text-xs text-muted">
              {billingTimestamp('Last checked', report.checkedAt)}
            </p>
            <p className="mt-1 text-xs text-muted">
              {billingTimestamp('Fetched', report.fetchedAt)}
            </p>
            <p className="mt-1 text-xs text-muted">
              {billingTimestamp('Latest export', report.latestExportAt)} ·{' '}
              {billingTimestamp('Latest usage', report.latestUsageAt)}
            </p>
            {services.size > 0 || report.forecast ? (
              <details className="mt-3 rounded-xl bg-sunken/45 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Run rate and service details
                </summary>
                {report.forecast ? (
                  <div className="mt-3 rounded-lg bg-sunken/55 p-3">
                    {report.forecast.totals.map((total) => (
                      <div key={total.currency} className="flex flex-wrap justify-between gap-3">
                        <p className="text-sm">
                          Estimated month end{' '}
                          <strong className="block text-lg tabular-nums">
                            {money(total.projected, total.currency)}
                          </strong>
                        </p>
                        <p className="text-sm text-muted">
                          Average per day{' '}
                          <span className="block tabular-nums">
                            {money(total.dailyAverage, total.currency)}
                          </span>
                        </p>
                      </div>
                    ))}
                    <p className="mt-2 text-xs text-muted">
                      {report.forecast.message} Observed {report.forecast.observedDays} of{' '}
                      {report.forecast.daysInMonth} days through {report.forecast.through}.
                    </p>
                  </div>
                ) : report.status === 'reported' ? (
                  <p className="mt-3 text-xs text-muted">
                    {report.id === 'openai-billing'
                      ? 'Month-end estimate unavailable: source usage freshness is not reported.'
                      : 'Month-end estimate needs at least three days of reported usage.'}
                  </p>
                ) : null}
                {services.size > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[600px] text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted">
                          <th className="py-2">Service and detail</th>
                          <th className="text-right">Currency</th>
                          <th className="text-right">
                            {report.amountBasis === 'provider_reported_cost'
                              ? 'Reported cost'
                              : 'Cost'}
                          </th>
                          <th className="text-right">Credits</th>
                          <th className="text-right">Net spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...services.entries()].map(([key, service]) => (
                          <tr key={key} className="border-t border-edge/60">
                            <td className="py-2 pr-3">
                              <span className="font-medium">{service.service}</span>
                              {service.detail ? (
                                <span className="block text-xs text-muted">{service.detail}</span>
                              ) : null}
                              {service.projectId ? (
                                <span className="block text-xs text-muted">
                                  Project: {service.projectId}
                                </span>
                              ) : null}
                              {service.apiKeyId ? (
                                <span className="block text-xs text-muted">
                                  API key ID: {service.apiKeyId}
                                </span>
                              ) : null}
                            </td>
                            <td className="text-right tabular-nums">{service.currency}</td>
                            <td className="text-right tabular-nums">
                              {money(service.cost, service.currency)}
                            </td>
                            <td className="text-right tabular-nums">
                              {report.amountBasis === 'provider_reported_cost'
                                ? 'Not reported'
                                : money(service.credits, service.currency)}
                            </td>
                            <td className="text-right tabular-nums">
                              {report.amountBasis === 'provider_reported_cost'
                                ? 'Not reported'
                                : money(service.net, service.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </details>
            ) : null}
            {report.id === 'google-cloud' && report.status === 'not_configured' ? (
              <div className="mt-3 text-sm">
                <p className="font-medium text-muted">
                  Google Cloud costs are unavailable in this report. Missing costs are unknown, not
                  zero.
                </p>
                <a
                  className="mt-2 inline-block underline"
                  href="https://console.cloud.google.com/billing"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Cloud Billing
                </a>
              </div>
            ) : null}
            {report.setup ||
            (report.id === 'google-cloud' && report.status === 'not_configured') ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm font-medium">
                  {report.setup ? 'Review billing setup' : 'Export setup steps and guide'}
                </summary>
                {report.setup ? (
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
                    {report.setup.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-xs text-muted">
                    Enable standard usage export in Google Cloud Billing, then connect its BigQuery
                    table and grant this installation read access. Initial data can take hours or
                    days.
                  </p>
                )}
                {report.id === 'google-cloud' ? (
                  <a
                    className="mt-2 inline-block underline"
                    href="https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Export setup guide
                  </a>
                ) : null}
              </details>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

function coverageLabel(state: BillingCoverageState): string {
  switch (state) {
    case 'partial':
      return 'Partial';
    case 'included':
      return 'Included in provider report';
    case 'stale':
      return 'Stale';
    case 'not_configured':
      return 'Setup needed';
    case 'unsupported':
      return 'No billing feed';
    case 'ledger_only':
      return 'Ledger only';
    case 'not_imported':
      return 'Not imported';
    case 'overlapping':
      return 'Overlaps provider billing';
    case 'unknown':
      return 'Unknown';
  }
}

export function BillingCoverageSummary({ coverage }: { coverage: BillingCoverageProjection }) {
  return (
    <section
      aria-label="Billing coverage"
      className="mb-6 rounded-2xl border border-edge bg-sunken/45 p-4"
    >
      <h2 className="font-semibold">{coverage.title}</h2>
      <p className="mt-1 text-sm text-muted">{coverage.summary}</p>
      {coverage.statusSummary ? (
        <p className="mt-2 text-sm font-medium text-muted">{coverage.statusSummary}</p>
      ) : null}
      <p className="mt-2 text-xs text-muted">{coverage.overlapWarning}</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Coverage sources and gaps ({coverage.entries.length})
        </summary>
        <ul className="mt-3 space-y-3 border-t border-edge/60 pt-3">
          {coverage.entries.map((entry) => (
            <li key={entry.id} className="text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-medium">{entry.label}</span>
                <span className="text-xs text-muted">{coverageLabel(entry.state)}</span>
              </div>
              <p className="text-xs text-muted">
                {entry.scope}
                {entry.period ? ` · ${entry.period}` : ''}
                {entry.source ? ` · ${entry.source}` : ''}
              </p>
              <p className="mt-1 text-xs text-muted">{entry.detail}</p>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
