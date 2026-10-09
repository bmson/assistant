import type { SpendSource } from './contracts.js';

/**
 * A billable operation could not reserve enough budget to start safely.
 * Callers that own a workflow should park it until `resumeAt`; request/maintenance
 * callers may surface the error or retry after the reset.
 */
export class BudgetReservationError extends Error {
  constructor(
    message: string,
    public readonly resumeAt: Date,
  ) {
    super(message);
    this.name = 'BudgetReservationError';
  }
}

/**
 * Total cost governance (Phase 27): one ledger for every billable event, and
 * pre-flight reservations so expensive actions check remaining budget BEFORE
 * they start. The ceiling hierarchy is monthly > daily > per-task; hitting
 * 100% parks work as waiting_budget (never kills it mid-step), and caps
 * auto-release when their period resets.
 */

/**
 * CI wiring registry: every spend source in the schema must name where its
 * ledger rows come from. Adding a source to SPEND_SOURCES without an entry
 * here fails the cost.test.ts registry check — that failure is the point:
 * new spend categories must be wired into the ledger before they ship.
 */
export const LEDGER_WIRING: Record<SpendSource, string> = {
  model:
    'ModelRouter.meter() — provider-reported cost or explicitly labeled token/preflight estimate; live voice uses usage rates',
  embedding:
    'ModelRouter.meter() — provider-reported cost or explicit estimate from the configured model rates',
  twilio_sms:
    'Encoding-aware segment reservations for sms.send and every SMS channel delivery; provider usage reconciled when available',
  twilio_voice_min: 'reserved for Phase 9 voice calls (rate seeded, no caller yet)',
  cloud_run_job_sec:
    'ToolDispatcher reservation on browser.execute launch; executor reconciles at job settle',
  storage_gb_month:
    'legacy/manual operation ledger; actual Google Cloud storage spend is read separately from the Cloud Billing export',
  external_api: 'web.search records a per-call cost here (search provider queries)',
};

/** Fallbacks when the rate_table row is missing (also the seed values). */
export const DEFAULT_RATES: Record<string, { unit: string; unitPriceUsd: number }> = {
  embedding_mtok: { unit: 'mtok', unitPriceUsd: 0.02 },
  twilio_sms: { unit: 'segment', unitPriceUsd: 0.0079 },
  twilio_voice_min: { unit: 'minute', unitPriceUsd: 0.014 },
  cloud_run_job_sec: { unit: 'second', unitPriceUsd: 0.00006 },
  storage_gb_month: { unit: 'gb-month', unitPriceUsd: 0.023 },
};

/** Next daily budget reset (00:05 server time) — when parked work auto-resumes. */
export function nextDailyReset(from = new Date()): Date {
  const next = new Date(from);
  next.setHours(24, 5, 0, 0);
  return next;
}

/** Next monthly budget reset (1st, 00:05 server time). */
export function nextMonthlyReset(from = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 5, 0, 0);
}
