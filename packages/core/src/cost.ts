import {
  conversations,
  createPostgresCostRepository,
  type Db,
  messages,
  toolCache,
} from '@assistant/db';
import type {
  CostAttemptMetadata,
  CostEventInput,
  CostRepository,
  CostTotals,
  MaintenanceRepository,
  ReservationActual,
  ReserveCostInput,
  ReserveOutcome,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';

export type { CostEventInput, CostTotals, ReserveOutcome } from '@assistant/persistence';
export {
  BudgetReservationError,
  DEFAULT_RATES,
  LEDGER_WIRING,
  nextDailyReset,
  nextMonthlyReset,
} from '@assistant/persistence';

import { DEFAULT_RATES, nextDailyReset, nextMonthlyReset } from '@assistant/persistence';

type CostStore = Db | CostRepository;
function costs(store: CostStore): CostRepository {
  return 'kind' in store && store.kind === 'cost-repository'
    ? (store as CostRepository)
    : createPostgresCostRepository(store as Db);
}
export async function getRate(
  store: CostStore,
  key: string,
): Promise<{ unit: string; unitPriceUsd: number }> {
  const row = await costs(store).getRate(key);
  if (row) return row;
  const fallback = DEFAULT_RATES[key];
  if (!fallback) throw new Error(`no rate for key: ${key}`);
  return fallback;
}
export function costTotals(store: CostStore): Promise<CostTotals> {
  return costs(store).totals();
}
export function recordCostEvent(store: CostStore, input: CostEventInput): Promise<void> {
  return costs(store).record(input);
}
export function reserveCost(store: CostStore, input: ReserveCostInput): Promise<ReserveOutcome> {
  return costs(store).reserve(input);
}
export function beginCostAttempt(
  store: CostStore,
  id: string,
  metadata: CostAttemptMetadata,
): Promise<boolean> {
  return costs(store).beginAttempt(id, metadata);
}
export function markCostAttemptUnknown(
  store: CostStore,
  id: string,
  reason: string,
  providerReceipt?: { requestId?: string; endpoint?: string },
): Promise<void> {
  return costs(store).markAttemptUnknown(id, reason, providerReceipt);
}
export function reconcileReservation(
  store: CostStore,
  id: string,
  actual: ReservationActual,
): Promise<void> {
  return costs(store).reconcile(id, actual);
}
export function releaseReservation(store: CostStore, id: string): Promise<void> {
  return costs(store).release(id);
}
export function releaseStaleReservations(
  store: CostStore,
  age = 120,
  batch = 500,
): Promise<number> {
  return costs(store).releaseStale(age, batch);
}

// ── Threshold notifications (sweep hook) ─────────────────────────────────────

const NOTIFY_THRESHOLDS = [50, 80, 100] as const;

async function notifyOwner(db: Db, agentId: string, text: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
  const conversationId =
    existing?.id ??
    (
      await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'assistant', title: 'Notifications' })
        .returning()
    )[0]?.id;
  if (!conversationId) return;
  await db.insert(messages).values({
    conversationId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  });
}

/**
 * Sweep hook: notify the owner once per threshold per period (50/80/100% of
 * daily and monthly caps). Dedupe rides on tool_cache keys that expire with
 * the period — no extra table for a once-a-day ping.
 */
export async function emitBudgetNotices(
  store: Db | { costs: CostRepository; maintenance: MaintenanceRepository },
  agentId: string,
): Promise<string[]> {
  const portable = 'maintenance' in store ? store : null;
  const totals = await costTotals(portable ? portable.costs : (store as Db));
  const emitted: string[] = [];

  const periods = [
    {
      name: 'daily' as const,
      spent: totals.dailySpentUsd,
      limit: totals.dailyLimitUsd,
      periodKey: new Date().toISOString().slice(0, 10),
      expiresAt: nextDailyReset(),
    },
    {
      name: 'monthly' as const,
      spent: totals.monthlySpentUsd,
      limit: totals.monthlyLimitUsd,
      periodKey: new Date().toISOString().slice(0, 7),
      expiresAt: nextMonthlyReset(),
    },
  ];

  for (const period of periods) {
    if (!Number.isFinite(period.limit) || period.limit <= 0) continue;
    const pct = (period.spent / period.limit) * 100;
    const crossed = [...NOTIFY_THRESHOLDS].reverse().find((t) => pct >= t);
    if (!crossed) continue;

    const cacheKey = `budget-notice:${period.name}:${crossed}:${period.periodKey}`;
    const text =
      crossed >= 100
        ? `Budget: the ${period.name} cap is exhausted ($${period.spent.toFixed(2)} of $${period.limit.toFixed(2)}). Non-critical work is parked as waiting_budget and resumes when the ${period.name} period resets; owner chat keeps a small carve-out. Raise the cap on the [Costs page](/costs) if you want work to continue now.`
        : `Budget: ${Math.round(pct)}% of the ${period.name} cap used ($${period.spent.toFixed(2)} of $${period.limit.toFixed(2)}).`;
    if (portable) {
      // The dedupe key and the Notifications message commit together.
      const posted = await portable.maintenance.postBudgetNotice({
        cacheKey,
        pct: Math.round(pct),
        expiresAt: period.expiresAt,
        text,
      });
      if (posted) emitted.push(cacheKey);
      continue;
    }
    const db = store as Db;
    const [seen] = await db.select().from(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    if (seen) continue;
    await db
      .insert(toolCache)
      .values({
        cacheKey,
        toolName: 'budget.notice',
        result: { pct: Math.round(pct) },
        expiresAt: period.expiresAt,
      })
      .onConflictDoNothing();
    await notifyOwner(db, agentId, text);
    emitted.push(cacheKey);
  }
  return emitted;
}
