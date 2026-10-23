export type DiagnosticModelLedgerRow = {
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
};

export type DiagnosticCostRow = { usd: string; evidence: unknown };

export type DiagnosticReservationRow = {
  status: string;
  estimatedUsd: string;
  actualUsd: string | null;
  unknownReason: string | null;
};

export type DiagnosticAccountingInput = {
  routerInvocations: number;
  modelRows: DiagnosticModelLedgerRow[];
  costRows: DiagnosticCostRow[];
  reservations: DiagnosticReservationRow[];
  executionError?: string;
};

export type DiagnosticAccounting = {
  status: 'complete' | 'incomplete' | 'not-applicable';
  missing: string[];
  chargeOutcome: 'known' | 'unknown' | 'not-applicable';
  limitation: string;
  routerInvocations: number;
  modelLedgerRows: number;
  recordedInputTokens: number;
  recordedOutputTokens: number;
  costEvidence: unknown[];
  reservations: DiagnosticReservationRow[];
};

const COST_BASES = new Set([
  'provider_reported',
  'token_rate',
  'preflight_estimate',
  'component_ledger',
  'unknown',
]);

function nonnegativeDecimal(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function addOnce(missing: string[], reason: string) {
  if (!missing.includes(reason)) missing.push(reason);
}

/** Builds a conservative receipt from observed router work and persisted accounting rows. */
export function buildDiagnosticAccounting(input: DiagnosticAccountingInput): DiagnosticAccounting {
  const missing: string[] = [];
  const routerInvocations =
    Number.isSafeInteger(input.routerInvocations) && input.routerInvocations >= 0
      ? input.routerInvocations
      : 0;
  if (routerInvocations !== input.routerInvocations)
    addOnce(missing, 'router invocation count is malformed');
  if (input.executionError !== undefined)
    addOnce(missing, 'execution ended with an error; provider charge outcome is unverified');

  let recordedInputTokens = 0;
  let recordedOutputTokens = 0;
  let positiveModelCost = false;
  for (const row of input.modelRows) {
    const inputTokens = row.inputTokens;
    const outputTokens = row.outputTokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      addOnce(missing, 'model ledger has malformed token counts');
    } else {
      recordedInputTokens += inputTokens;
      recordedOutputTokens += outputTokens;
      if (!Number.isSafeInteger(recordedInputTokens) || !Number.isSafeInteger(recordedOutputTokens))
        addOnce(missing, 'aggregate token count exceeds safe integer range');
      if (inputTokens === 0 && outputTokens === 0)
        addOnce(missing, 'zero token ledger values may represent missing provider usage');
    }
    const cost = nonnegativeDecimal(row.costUsd);
    if (cost === null) addOnce(missing, 'model ledger has malformed or negative cost');
    else if (cost > 0) positiveModelCost = true;
  }

  if (routerInvocations > 0 && input.modelRows.length === 0)
    addOnce(missing, 'model cost ledger absent for observed router work');
  if (
    routerInvocations > 0 &&
    input.modelRows.length > 0 &&
    routerInvocations !== input.modelRows.length
  )
    addOnce(missing, 'router invocation and model ledger row counts differ');
  if (routerInvocations === 0 && input.modelRows.length > 0)
    addOnce(missing, 'model ledger exists without an observed router invocation');
  if (routerInvocations > 0 || input.modelRows.length > 0)
    addOnce(
      missing,
      'router traces and model ledger rows cannot be mapped one-to-one; preflight calls and retries make counts inconclusive',
    );
  if (positiveModelCost && input.costRows.length === 0)
    addOnce(missing, 'positive model cost has no cost evidence row');
  if (input.costRows.length > 0 && input.modelRows.length === 0)
    addOnce(missing, 'cost evidence exists without a model ledger row');

  for (const row of input.costRows) {
    if (nonnegativeDecimal(row.usd) === null)
      addOnce(missing, 'cost evidence has malformed or negative amount');
    const evidence = row.evidence;
    const basis =
      evidence && typeof evidence === 'object' && 'basis' in evidence
        ? (evidence as { basis?: unknown }).basis
        : undefined;
    if (typeof basis !== 'string' || !COST_BASES.has(basis))
      addOnce(missing, 'cost evidence has missing or malformed basis');
    else if (basis === 'unknown') addOnce(missing, 'unknown cost evidence');
  }

  const reservations = input.reservations.map((row) => ({ ...row }));
  for (const row of reservations) {
    if (nonnegativeDecimal(row.estimatedUsd) === null)
      addOnce(missing, 'reservation has malformed or negative estimate');
    const actual = row.actualUsd === null ? null : nonnegativeDecimal(row.actualUsd);
    if (row.actualUsd !== null && actual === null)
      addOnce(missing, 'reservation has malformed or negative actual charge');
    if (row.status === 'held' || row.status === 'dispatching' || row.status === 'unknown')
      addOnce(missing, 'unsettled cost reservation');
    else if (row.status !== 'reconciled' && row.status !== 'released')
      addOnce(missing, 'reservation has unknown status');
    if (row.status === 'reconciled' && actual === null)
      addOnce(missing, 'reconciled reservation has no actual charge');
  }

  const status: DiagnosticAccounting['status'] = missing.length
    ? 'incomplete'
    : routerInvocations === 0 &&
        input.modelRows.length === 0 &&
        input.costRows.length === 0 &&
        reservations.length === 0
      ? 'not-applicable'
      : 'complete';
  const chargeOutcome: DiagnosticAccounting['chargeOutcome'] =
    status === 'not-applicable' ? 'not-applicable' : status === 'complete' ? 'known' : 'unknown';

  return {
    status,
    missing,
    chargeOutcome,
    limitation:
      'Attempt-level charge coverage is not proven: router-call and model-ledger row counts cannot establish one-to-one coverage across preflight calls or retries.',
    routerInvocations,
    modelLedgerRows: input.modelRows.length,
    recordedInputTokens,
    recordedOutputTokens,
    costEvidence: input.costRows.map((row) => row.evidence),
    reservations,
  };
}

export type DiagnosticInterruptedReceipt = {
  caseId: string;
  status: 'interrupted';
  errorName: string;
  accounting: {
    status: 'incomplete';
    chargeOutcome: 'unknown';
    missing: string[];
  };
  modelCalls: null;
  tokens: null;
  costUsd: null;
  stopFollowingCases: true;
};

/** Records an interrupted case without treating absent post-error rows as zero charges. */
export function buildDiagnosticInterruptedReceipt(
  caseId: string,
  error: unknown,
): DiagnosticInterruptedReceipt {
  const errorName =
    error &&
    typeof error === 'object' &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test((error as { name: string }).name)
      ? (error as { name: string }).name
      : 'Error';
  return {
    caseId,
    status: 'interrupted',
    errorName,
    accounting: {
      status: 'incomplete',
      chargeOutcome: 'unknown',
      missing: ['execution interrupted; provider charge outcome is unknown'],
    },
    modelCalls: null,
    tokens: null,
    costUsd: null,
    stopFollowingCases: true,
  };
}
