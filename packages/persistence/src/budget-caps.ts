/** Owner-scoped writes to the live cost policy and default task cap. */
export interface BudgetCapsRepository {
  readonly kind: 'budget-caps-repository';
  update(
    agentId: string,
    values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
  ): Promise<void>;
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
