import type { BudgetRetry } from '@assistant/persistence';

/**
 * Pure budget evaluation — the order matters and is part of the contract:
 * hard task cap → park (owner can grant more); hard daily/monthly → block
 * (read-only cheap mode); any soft threshold → degrade to fallback model.
 */

export interface BudgetSnapshot {
  /** Per-task cap; both undefined when the call has no task context. */
  taskLimitUsd?: number;
  taskSpentUsd?: number;
  dailyLimitUsd: number;
  dailySpentUsd: number;
  monthlyLimitUsd: number;
  monthlySpentUsd: number;
  /**
   * Estimated USD held by unreconciled reservations. Holds are worst-case
   * (often several times the eventual actual), so they count against the hard
   * caps — a launched job must not be double-spendable — but not against the
   * soft threshold, where paper spend was degrading the model for concurrent
   * tasks that never actually approached the cap.
   */
  heldUsd: number;
  dailyHeldUsd?: number;
  monthlyHeldUsd?: number;
  /** Percentage (0-100) at which degradation kicks in. */
  softPct: number;
}

export type BudgetDecision =
  | { mode: 'primary' }
  | { mode: 'fallback'; reason: string }
  | { mode: 'park'; reason: string }
  | { mode: 'block'; reason: string; scope?: 'monthly' | 'daily'; budgetRetry?: BudgetRetry };

export interface BudgetEvalOptions {
  /**
   * Critical carve-out (owner chat/SMS replies): a hard daily/monthly cap
   * degrades to the fallback model instead of blocking, until spend passes
   * 110% of the cap — the owner can always reach their assistant.
   */
  critical?: boolean;
}

const CARVE_OUT_FACTOR = 1.1;

export function evaluateBudget(s: BudgetSnapshot, opts: BudgetEvalOptions = {}): BudgetDecision {
  const hard = (spent: number, limit: number): boolean => {
    if (spent < limit) return false;
    // critical work keeps running (degraded) inside the carve-out margin
    return !(opts.critical && spent < limit * CARVE_OUT_FACTOR);
  };
  // Hard per-task cap → park (the owner can grant more). Critical owner replies
  // get the same 1.1x carve-out here that reserveCost already grants on the task
  // cap and that the daily/monthly branches grant below — otherwise a chat/SMS
  // answer that nudged just over its own task budget is stranded in
  // needs_attention with the reply never delivered, instead of degrading to the
  // fallback model to finish.
  if (s.taskLimitUsd !== undefined && hard(s.taskSpentUsd ?? 0, s.taskLimitUsd)) {
    return {
      mode: 'park',
      reason: `task budget exhausted ($${(s.taskSpentUsd ?? 0).toFixed(4)} of $${s.taskLimitUsd.toFixed(4)})`,
    };
  }
  const monthlyCommitted = s.monthlySpentUsd + (s.monthlyHeldUsd ?? s.heldUsd);
  const dailyCommitted = s.dailySpentUsd + (s.dailyHeldUsd ?? s.heldUsd);
  if (hard(monthlyCommitted, s.monthlyLimitUsd)) {
    return {
      mode: 'block',
      scope: 'monthly',
      reason: `monthly budget exhausted ($${monthlyCommitted.toFixed(2)} of $${s.monthlyLimitUsd.toFixed(2)})`,
    };
  }
  if (hard(dailyCommitted, s.dailyLimitUsd)) {
    return {
      mode: 'block',
      scope: 'daily',
      reason: `daily budget exhausted ($${dailyCommitted.toFixed(2)} of $${s.dailyLimitUsd.toFixed(2)})`,
    };
  }

  const soft = (spent: number, limit: number) => limit > 0 && spent >= (limit * s.softPct) / 100;
  if (s.taskLimitUsd !== undefined && soft(s.taskSpentUsd ?? 0, s.taskLimitUsd)) {
    return { mode: 'fallback', reason: 'task budget above soft threshold' };
  }
  if (soft(s.dailySpentUsd, s.dailyLimitUsd)) {
    return { mode: 'fallback', reason: 'daily budget above soft threshold' };
  }
  if (soft(s.monthlySpentUsd, s.monthlyLimitUsd)) {
    return { mode: 'fallback', reason: 'monthly budget above soft threshold' };
  }
  return { mode: 'primary' };
}
