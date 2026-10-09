import { getCostsDashboard } from '@assistant/application/costs';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, getFirestoreMobileCosts } from '@assistant/firestore';
import { COST_BASIS_LABELS, costBasis } from '@assistant/persistence';
import Link from 'next/link';
import { BudgetCapsForm } from '@/app/costs/budget-caps-form';
import { ProviderBillingCards } from '@/app/costs/provider-billing-cards';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, truncate } from '@/lib/format';
import { getBillingOverview, getDb } from '@/lib/server';
import { cardShellClass, InfoGrid, InfoItem, PageHeader, PageShell } from '@/lib/ui';
import { taskTypeLabel } from '@/lib/views';

export const metadata = { title: 'Costs' };

export const dynamic = 'force-dynamic';

function Bar({ spent, held, limit }: { spent: number; held: number; limit: number }) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const spentPct = Math.min(100, (spent / limit) * 100);
  const heldPct = Math.min(100 - spentPct, (held / limit) * 100);
  const color = spentPct >= 100 ? 'bg-red-500' : spentPct >= 80 ? 'bg-amber-500' : 'bg-accent';
  return (
    <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-sunken">
      <div className={`h-full ${color}`} style={{ width: `${spentPct}%` }} />
      <div className="h-full bg-muted/50" style={{ width: `${heldPct}%` }} />
    </div>
  );
}

export default async function CostsPage() {
  await requireOwner();
  const config = loadConfig();
  const firestore = config.PERSISTENCE_DRIVER === 'firestore';
  let dashboard: Awaited<ReturnType<typeof getCostsDashboard>>;
  if (firestore) {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      dashboard = await getFirestoreMobileCosts(store, config.FIRESTORE_AGENT_ID);
    } finally {
      await store.db.terminate();
    }
  } else {
    dashboard = await getCostsDashboard(getDb());
  }
  const {
    timezone: tz,
    totals,
    bySource,
    byModel,
    topTasks,
    held,
    recent,
    parkedTasks: parked,
    taskDefaultLimit,
  } = dashboard;
  const billing = await getBillingOverview();

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Costs"
        intro="See this month’s provider charges, estimate month-end costs, and control assistant usage."
      />

      {parked > 0 ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {parked} {parked === 1 ? 'task is' : 'tasks are'} paused because a spending limit was
          reached
          {firestore ? (
            '.'
          ) : (
            <>
              {' — '}
              <Link href="/tasks" className="underline">
                see tasks
              </Link>{' '}
              or adjust the limits below.
            </>
          )}
        </p>
      ) : null}

      <ProviderBillingCards reports={billing} />
      <h2 className="mt-8 text-lg font-semibold">Assistant usage ledger</h2>
      <p className="mt-1 text-sm text-muted">
        Includes estimates used to enforce task, daily and monthly caps. These caps do not limit
        your cloud bill. Ledger costs overlap provider billing above and are not added to it.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {dashboard.byEvidence.map((row) => (
          <div key={row.basis} className={`${cardShellClass} p-3 text-sm`}>
            <p className="text-muted">{COST_BASIS_LABELS[row.basis]}</p>
            <p className="mt-1 font-medium tabular-nums">
              {formatUsd(row.usd)} · {row.count} events this month
            </p>
          </div>
        ))}
      </div>

      {/* Burn vs caps */}
      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        {(
          [
            { label: 'This month', spent: totals.monthlySpentUsd, limit: totals.monthlyLimitUsd },
            { label: 'Today', spent: totals.dailySpentUsd, limit: totals.dailyLimitUsd },
          ] as const
        ).map((p) => (
          <div key={p.label} className={`${cardShellClass} p-4`}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-strong">{p.label}</p>
              <p className="font-display text-2xl font-semibold tracking-[-0.04em] tabular-nums">
                {formatUsd(p.spent.toFixed(4))}
              </p>
            </div>
            <Bar spent={p.spent} held={totals.heldUsd} limit={p.limit} />
            <InfoGrid className="mt-3">
              <InfoItem label="Limit">
                {Number.isFinite(p.limit) ? formatUsd(p.limit.toFixed(2)) : 'No cap'}
              </InfoItem>
              <InfoItem label="Reserved">{formatUsd(totals.heldUsd.toFixed(4))}</InfoItem>
            </InfoGrid>
          </div>
        ))}
      </section>

      {/* Cap editing */}
      <section className="mt-6">
        <h2 className="mb-2 text-lg font-semibold">Assistant spending limits</h2>
        <p className="mb-3 text-sm text-muted">
          These limits pause assistant work using its usage ledger. They do not change Google Cloud
          billing budgets or stop hosting, storage and other cloud charges.
        </p>
        <BudgetCapsForm
          initial={{
            task_default: taskDefaultLimit ?? '',
            daily: Number.isFinite(totals.dailyLimitUsd) ? String(totals.dailyLimitUsd) : '',
            monthly: Number.isFinite(totals.monthlyLimitUsd) ? String(totals.monthlyLimitUsd) : '',
          }}
        />
      </section>

      <details className="mt-8 rounded-2xl bg-sunken/55">
        <summary className="disclosure flex items-center gap-2 cursor-pointer px-5 py-4 text-sm font-medium">
          Detailed usage
        </summary>
        <div className="border-t border-edge px-5 pb-5">
          {held.length > 0 ? (
            <section className="mt-5">
              <h2 className="text-sm font-medium">In-progress work</h2>
              <p className="mt-1 text-xs text-muted">
                Estimated costs reserved for work that has not finished yet.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {held.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {r.source} — {r.description || 'No description'}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {formatUsd(r.estimatedUsd)} estimated
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mt-5 grid gap-6 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-medium">By source this month</h2>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {bySource.map((row) => (
                    <tr key={row.source} className="border-t border-edge/60">
                      <td className="py-1.5">{row.source}</td>
                      <td className="py-1.5 text-right text-xs text-muted">{row.count}×</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatUsd(String(row.usd ?? '0'))}
                      </td>
                    </tr>
                  ))}
                  {bySource.length === 0 ? (
                    <tr>
                      <td className="py-1.5 text-muted">No spending yet this month</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div>
              <h2 className="text-sm font-medium">By model this month</h2>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {byModel.map((row) => (
                    <tr key={row.model} className="border-t border-edge/60">
                      <td className="max-w-0 truncate py-1.5">{row.model}</td>
                      <td className="py-1.5 text-right text-xs text-muted">{row.count}×</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatUsd(String(row.usd ?? '0'))}
                      </td>
                    </tr>
                  ))}
                  {byModel.length === 0 ? (
                    <tr>
                      <td className="py-1.5 text-muted">No model calls this month</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-sm font-medium">Most expensive tasks this month</h2>
            <div className="mt-3 flex flex-col gap-2">
              {topTasks.map((row) => {
                const content = (
                  <>
                    <span className="min-w-0 truncate">
                      <span className="text-xs text-muted">[{taskTypeLabel(row.type)}]</span>{' '}
                      {truncate(row.progress || row.taskId || '', 80)}
                    </span>
                    <span className="shrink-0">{formatUsd(String(row.usd ?? '0'))}</span>
                  </>
                );
                return firestore ? (
                  <div
                    key={row.taskId}
                    className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-sm"
                  >
                    {content}
                  </div>
                ) : (
                  <Link
                    key={row.taskId}
                    href={`/tasks/${row.taskId}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-sm motion-safe:transition-colors hover:bg-sunken/30"
                  >
                    {content}
                  </Link>
                );
              })}
              {topTasks.length === 0 ? (
                <p className="text-sm text-muted">No task spending yet this month</p>
              ) : null}
            </div>
          </section>

          <section className="mt-6 overscroll-x-contain overflow-x-auto">
            <h2 className="text-sm font-medium">Recent ledger entries</h2>
            <table className="mt-3 w-full text-sm">
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} className="border-t border-edge/60">
                    <td className="py-1.5 text-xs text-muted whitespace-nowrap">
                      {formatDateTime(e.createdAt, tz)}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.source}
                      <span className="block text-xs text-muted">
                        {COST_BASIS_LABELS[costBasis(e.evidence)]}
                      </span>
                    </td>
                    <td className="max-w-0 truncate px-2 py-1.5 text-xs text-muted">
                      {e.description}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatUsd(e.usd)}</td>
                  </tr>
                ))}
                {recent.length === 0 ? (
                  <tr>
                    <td className="py-1.5 text-muted">No charges yet</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </div>
      </details>
    </PageShell>
  );
}
