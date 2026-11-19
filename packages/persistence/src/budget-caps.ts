import type { ReserveOutcome } from './contracts.js';
import { addMicros, MAX_LEDGER_USD_MICROS } from './money.js';
import type { TaskWake } from './task-lifecycle.js';

/** Owner-scoped writes to the live cost policy and default task cap. */
export interface BudgetCapsRepository {
  readonly kind: 'budget-caps-repository';
  update(
    agentId: string,
    values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
  ): Promise<TaskWake[]>;
}

export type BudgetCaps = Partial<Record<'task_default' | 'daily' | 'monthly', string>>;

/** Blank means unchanged; numeric strings are exact USD amounts rounded to cents. Zero stops spend. */
export function normalizeBudgetCaps(values: BudgetCaps): { caps?: BudgetCaps; error?: string } {
  const caps: Partial<Record<'task_default' | 'daily' | 'monthly', string>> = {};
  for (const scope of ['task_default', 'daily', 'monthly'] as const) {
    const raw = values[scope];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return { error: `${scope} must be a USD amount.` };
    const text = raw.trim();
    if (!text) continue;
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
      return { error: `${scope} must be a whole-cent USD amount.` };
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value > 10_000) {
      return { error: `${scope} must be at most $10,000.00.` };
    }
    caps[scope] = value.toFixed(2);
  }
  if (Object.keys(caps).length === 0) return { error: 'Enter at least one budget cap to update.' };
  return { caps };
}

export interface BudgetRetry {
  scope: 'daily' | 'monthly';
  nextAttemptMicros: number;
  critical: boolean;
}

export function budgetRetry(
  budget: Extract<ReserveOutcome, { ok: false }>['budget'],
  critical = false,
): BudgetRetry | undefined {
  if (!budget || (budget.scope !== 'daily' && budget.scope !== 'monthly')) return;
  if (!Number.isSafeInteger(budget.nextAttemptMicros) || budget.nextAttemptMicros <= 0) return;
  return { scope: budget.scope, nextAttemptMicros: budget.nextAttemptMicros, critical };
}

export function readBudgetRetry(state: unknown): BudgetRetry | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  const checkpoint = state as Record<string, unknown>;
  const pending = checkpoint.pendingApprovals;
  if (pending != null && (!Array.isArray(pending) || pending.length > 0)) return;
  const retry = checkpoint.budgetRetry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return;
  const { scope, nextAttemptMicros, critical } = retry as Partial<BudgetRetry>;
  if (
    (scope !== 'daily' && scope !== 'monthly') ||
    typeof critical !== 'boolean' ||
    typeof nextAttemptMicros !== 'number' ||
    !Number.isSafeInteger(nextAttemptMicros) ||
    nextAttemptMicros <= 0 ||
    nextAttemptMicros > MAX_LEDGER_USD_MICROS
  )
    return;
  return { scope, nextAttemptMicros, critical };
}

export function canWakeForBudget(
  retry: BudgetRetry,
  input: {
    dailySpent: number;
    monthlySpent: number;
    taskSpent: number;
    dailyHeld: number;
    monthlyHeld: number;
    taskHeld: number;
    dailyCap: number;
    monthlyCap: number;
    taskCap: number;
  },
): boolean {
  const factor = retry.critical ? 1.1 : 1;
  const amount = retry.nextAttemptMicros;
  return (
    addMicros(input.taskSpent, input.taskHeld, amount) <= MAX_LEDGER_USD_MICROS &&
    addMicros(input.taskSpent, input.taskHeld, amount) <= Math.floor(input.taskCap * factor) &&
    addMicros(input.dailySpent, input.dailyHeld, amount) <= Math.floor(input.dailyCap * factor) &&
    addMicros(input.monthlySpent, input.monthlyHeld, amount) <=
      Math.floor(input.monthlyCap * factor)
  );
}

export function budgetWakeScheduleId(trigger: unknown): string | undefined {
  const id = (trigger as { payload?: { scheduleId?: unknown } } | null)?.payload?.scheduleId;
  return typeof id === 'string' && id ? id : undefined;
}

export function budgetWakeScheduleIsCurrent(schedule: { taskTemplate: unknown; enabled: boolean }) {
  const template = schedule.taskTemplate as {
    reminderCancelledAt?: unknown;
    reminderDeliveredAt?: unknown;
  } | null;
  return schedule.enabled && !template?.reminderCancelledAt && !template?.reminderDeliveredAt;
}

export interface BudgetWakeCursor {
  scopes: Array<BudgetRetry['scope']>;
  after: { updatedAt: string; id: string };
}

export function readBudgetWakeCursor(value: unknown): BudgetWakeCursor | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<BudgetWakeCursor>;
  if (
    !Array.isArray(row.scopes) ||
    row.scopes.length < 1 ||
    row.scopes.length > 2 ||
    row.scopes.some((scope) => scope !== 'daily' && scope !== 'monthly') ||
    !row.after ||
    typeof row.after.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.after.updatedAt)) ||
    typeof row.after.id !== 'string' ||
    !row.after.id ||
    row.after.id.length > 1500
  )
    return null;
  return { scopes: [...new Set(row.scopes)], after: row.after };
}
