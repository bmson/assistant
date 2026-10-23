import {
  buildDiagnosticInterruptedReceipt,
  type DiagnosticInterruptedReceipt,
} from '../packages/tools/src/question-regression/calendar-diagnostic-accounting.js';

export type CompletedDiagnosticOutcome = {
  id: string;
  failures: string[];
  accountingStatus: 'complete' | 'incomplete' | 'not-applicable';
};

export type DiagnosticRunControlInput = {
  fixtureIds: string[];
  completed: CompletedDiagnosticOutcome[];
  interrupted?: DiagnosticInterruptedReceipt | null;
  live: boolean;
  remainingBudgetUsd: number;
  cleanupFailed: boolean;
};

export type DiagnosticRunControl = {
  notRun: string[];
  notRunReasons: Record<string, string>;
  stopReason:
    | 'prior_case_accounting_incomplete'
    | 'prior_case_interrupted_charge_unknown'
    | 'remaining_budget_below_0.10_usd_preflight_floor'
    | null;
  accountingComplete: boolean;
  chargeOutcome: 'unknown' | 'see_case_accounting';
  cleanupFailed: boolean;
  exitCode: 0 | 1;
};

/** Centralizes the CLI's conservative stop, budget-floor, and final exit decisions. */
export function decideDiagnosticRunControl(input: DiagnosticRunControlInput): DiagnosticRunControl {
  const index = new Map(input.fixtureIds.map((id, position) => [id, position]));
  if (index.size !== input.fixtureIds.length) throw new Error('fixture IDs must be unique');
  const completedIds = new Set(input.completed.map((outcome) => outcome.id));
  if (completedIds.size !== input.completed.length)
    throw new Error('completed outcome IDs must be unique');
  for (const outcome of input.completed) {
    if (!index.has(outcome.id))
      throw new Error(`completed outcome is outside the fixture list: ${outcome.id}`);
  }

  let stopIndex = -1;
  let stopReason: DiagnosticRunControl['stopReason'] = null;
  const completedById = new Map(input.completed.map((outcome) => [outcome.id, outcome]));
  const incomplete = input.fixtureIds
    .map((id) => completedById.get(id))
    .find((outcome) => outcome?.accountingStatus === 'incomplete');

  if (input.interrupted) {
    stopIndex = index.get(input.interrupted.caseId) ?? -1;
    stopReason = 'prior_case_interrupted_charge_unknown';
  } else if (incomplete) {
    stopIndex = index.get(incomplete.id) ?? -1;
    stopReason = 'prior_case_accounting_incomplete';
  }

  const notRunReasons: Record<string, string> = {};
  if (stopReason) {
    const reason = stopReason;
    const firstNotRunIndex = stopIndex < 0 ? 0 : stopIndex + 1;
    for (const fixtureId of input.fixtureIds.slice(firstNotRunIndex)) {
      if (!completedIds.has(fixtureId) && fixtureId !== input.interrupted?.caseId)
        notRunReasons[fixtureId] = reason;
    }
  } else if (input.live && input.remainingBudgetUsd < 0.1) {
    stopReason = 'remaining_budget_below_0.10_usd_preflight_floor';
    for (const fixtureId of input.fixtureIds) {
      if (!completedIds.has(fixtureId)) notRunReasons[fixtureId] = stopReason;
    }
  }

  const notRun = input.fixtureIds.filter((fixtureId) => fixtureId in notRunReasons);
  const hasIncomplete = input.completed.some(
    (outcome) => outcome.accountingStatus === 'incomplete',
  );
  const hasFailures = input.completed.some((outcome) => outcome.failures.length > 0);
  const accountingComplete =
    input.fixtureIds.length > 0 &&
    input.fixtureIds.every((fixtureId) => completedIds.has(fixtureId)) &&
    !hasIncomplete &&
    !input.interrupted &&
    notRun.length === 0 &&
    !input.cleanupFailed;
  const chargeOutcome = hasIncomplete || input.interrupted ? 'unknown' : 'see_case_accounting';
  const exitCode: 0 | 1 =
    input.completed.length === 0 ||
    hasFailures ||
    hasIncomplete ||
    input.interrupted ||
    notRun.length > 0 ||
    input.cleanupFailed
      ? 1
      : 0;

  return {
    notRun,
    notRunReasons,
    stopReason,
    accountingComplete,
    chargeOutcome,
    cleanupFailed: input.cleanupFailed,
    exitCode,
  };
}

/** Captures a thrown/aborted case without exposing error text or treating absent rows as zero. */
export async function captureDiagnosticCase<T>(
  caseId: string,
  run: () => Promise<T>,
): Promise<
  { result: T; interrupted: null } | { result: null; interrupted: DiagnosticInterruptedReceipt }
> {
  try {
    return { result: await run(), interrupted: null };
  } catch (error) {
    return { result: null, interrupted: buildDiagnosticInterruptedReceipt(caseId, error) };
  }
}
