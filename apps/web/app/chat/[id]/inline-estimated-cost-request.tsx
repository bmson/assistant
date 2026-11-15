'use client';

import type {
  EstimatedCostBudgetTracking,
  EstimatedCostDecision,
  EstimatedCostDecisionReceipt,
  EstimatedCostQuote,
  EstimatedCostRequestProjection,
} from '@assistant/persistence';
import { Check, CircleDollarSign, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { btnSm } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';
import { DecisionActions, DecisionCard } from './decision-card';
import {
  type CostDecisionStorage,
  canApproveCostQuote,
  clearCostDecisionAfterReceipt,
  costQuoteRefreshId,
  formatCostMicros,
  isReceiptForCostDecision,
  readCostDecision,
  retainCostDecision,
} from './estimated-cost-decision';
import {
  createEstimatedCostTransport,
  type EstimatedCostTransport,
} from './estimated-cost-transport';

const defaultTransport = createEstimatedCostTransport();

interface Props {
  part: EstimatedCostQuote;
  formSessionScope?: string;
  transport?: EstimatedCostTransport;
  storage?: CostDecisionStorage;
}

/** A parked request owns its decision state, never the composer's send state. */
export function InlineEstimatedCostRequest(props: Props) {
  return (
    <CostRequest
      key={`${props.formSessionScope ?? ''}:${props.part.operationId}:${props.part.quoteId}:${props.part.quoteVersion}`}
      {...props}
    />
  );
}

function CostRequest({ part, formSessionScope, transport = defaultTransport, storage }: Props) {
  const [request, setRequest] = useState<EstimatedCostRequestProjection | null>(null);
  const [tracking, setTracking] = useState<EstimatedCostBudgetTracking | null>(null);
  const [unresolved, setUnresolved] = useState<EstimatedCostDecision | null>(null);
  const [receipt, setReceipt] = useState<EstimatedCostDecisionReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'reading' | 'approve' | 'decline' | 'refresh' | null>(
    'reading',
  );
  const [now, setNow] = useState(Date.now);
  const active = useRef(false);
  const readGeneration = useRef(0);
  const locked = useRef(true);
  const journal = useRef<CostDecisionStorage | null>(null);
  const scope = useMemo(
    () => ({ session: formSessionScope ?? '', operationId: part.operationId }),
    [formSessionScope, part.operationId],
  );

  const acceptReceipt = useCallback(
    (decision: EstimatedCostDecision, result: EstimatedCostDecisionReceipt) => {
      if (!journal.current || !isReceiptForCostDecision(result, decision)) {
        throw new Error('The result does not confirm this decision.');
      }
      if (!clearCostDecisionAfterReceipt(journal.current, scope, decision, result)) {
        throw new Error('The decision result could not be saved for recovery.');
      }
      setReceipt(result);
      setUnresolved(null);
    },
    [scope],
  );

  // Initial transcript data is descriptive. Only a canonical read enables a decision.
  useEffect(() => {
    active.current = true;
    const generation = ++readGeneration.current;
    const current = () => active.current && readGeneration.current === generation;
    locked.current = true;
    const read = async () => {
      try {
        if (!formSessionScope) throw new Error('Sign in again before reviewing this request.');
        journal.current = storage ?? window.sessionStorage;
        const pending = readCostDecision(journal.current, scope);
        if (current()) setUnresolved(pending);
        const result = await transport.read(part.operationId);
        if (!current()) return;
        if (!result.ok) throw new Error(result.message);
        setRequest(result.request);
        setTracking(result.tracking);
        if (pending) {
          const recovery = await transport.receipt(part.operationId, pending.decisionId);
          if (!current()) return;
          if (!recovery.ok)
            throw new Error(
              'The previous decision is not confirmed. Check its result before deciding again.',
            );
          acceptReceipt(pending, recovery.receipt);
        }
      } catch (cause) {
        if (current()) setError(message(cause));
      } finally {
        if (current()) {
          locked.current = false;
          setAction(null);
        }
      }
    };
    void read();
    return () => {
      active.current = false;
    };
  }, [acceptReceipt, formSessionScope, part.operationId, scope, storage, transport]);

  async function run(kind: NonNullable<typeof action>, work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setAction(kind);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (active.current) setError(message(cause));
    } finally {
      if (active.current) {
        locked.current = false;
        setAction(null);
        setNow(Date.now());
      }
    }
  }

  async function readCurrent() {
    setTracking(null);
    const result = await transport.read(part.operationId);
    if (!active.current) return;
    if (!result.ok) throw new Error(result.message);
    setRequest(result.request);
    setTracking(result.tracking);
  }

  const quote = request?.quote ?? part;
  const pending = request?.status === 'pending';
  const expiry =
    request?.status === 'approved' ? request.grantExpiresAt : pending ? quote.expiresAt : null;
  useEffect(() => {
    if (!expiry) return;
    const update = () => setNow(Date.now());
    update();
    const remaining = Date.parse(expiry) - Date.now();
    const timer =
      remaining > 0 ? window.setTimeout(update, Math.min(2_147_483_647, remaining + 1)) : null;
    document.addEventListener('visibilitychange', update);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expiry]);
  const quoteCurrent =
    tracking?.complete &&
    tracking.recordedDailyMicros === quote.recordedDailyMicros &&
    tracking.recordedMonthlyMicros === quote.recordedMonthlyMicros &&
    tracking.totalHeldMicros === quote.totalHeldMicros &&
    tracking.historicalUnknownMicros === quote.eligibleHistoricalUnknownMicros &&
    tracking.pendingApprovalMicros === quote.pendingApprovalMicros;
  const endedHere =
    receipt?.quoteId === quote.quoteId &&
    (receipt?.status === 'approved' || receipt?.status === 'declined');
  const staleHere = receipt?.status === 'stale' && receipt.quoteId === quote.quoteId;
  const canDecide = pending && !endedHere && !unresolved && !action;

  function decide(choice: 'approve' | 'decline') {
    if (!canDecide || !journal.current) return;
    if (
      choice === 'approve' &&
      (!canApproveCostQuote(quote, Date.now()) || !quoteCurrent || staleHere)
    )
      return;
    void run(choice, async () => {
      const decision: EstimatedCostDecision = {
        operationId: part.operationId,
        quoteId: quote.quoteId,
        quoteVersion: quote.quoteVersion,
        decisionId: crypto.randomUUID(),
        decision: choice,
      };
      // No POST can start unless this exact intent survived a durable local readback.
      retainCostDecision(journal.current as CostDecisionStorage, scope, decision);
      setUnresolved(decision);
      setTracking(null);
      const result = await transport.decide(decision);
      if (!active.current) return;
      if (!result.ok)
        throw new Error('The decision is not confirmed. Check its result before deciding again.');
      acceptReceipt(decision, result.receipt);
      await readCurrent();
    });
  }

  const grantExpired = request?.status === 'approved' && Date.parse(request.grantExpiresAt) <= now;
  const heading = unresolved
    ? 'Spending decision unconfirmed'
    : endedHere && request?.status === 'pending'
      ? 'Updating request status'
      : grantExpired
        ? 'Unused allowance expired'
        : request?.status === 'approved'
          ? 'Allowance approved'
          : request?.status === 'declined'
            ? 'Request declined'
            : request?.status === 'cancelled'
              ? 'Request cancelled'
              : request?.status === 'expired_or_needs_refresh' ||
                  (pending && Date.parse(quote.expiresAt) <= now)
                ? 'Estimate needs refreshing'
                : 'Waiting for spending permission';
  const approved =
    request?.status === 'approved'
      ? { allowanceMicros: quote.allowanceMicros, expiresAt: request.grantExpiresAt }
      : null;
  const mayRefresh =
    !unresolved &&
    !endedHere &&
    request &&
    (request.status === 'pending' || request.status === 'expired_or_needs_refresh');

  return (
    <DecisionCard tone="info" icon={CircleDollarSign} label={heading}>
      <div className="min-w-0 break-words text-sm text-strong [overflow-wrap:anywhere]">
        <p className="font-medium">{quote.requestText}</p>
        <div className="mt-3 rounded-xl border border-edge/60 bg-sunken p-3">
          <p className="font-medium">
            {approved ? 'Approved allowance' : 'Requested allowance'}:{' '}
            {formatCostMicros(approved?.allowanceMicros ?? quote.allowanceMicros)}
          </p>
          <p className="mt-1 text-xs text-muted">
            For this request in total, across its next steps. If it needs more, it will ask again.
            This is an internal estimate, not a cap on the provider’s bill.
          </p>
          {!approved && pending ? (
            <>
              <p className="mt-2 text-xs text-muted">
                Next step estimated at {formatCostMicros(quote.nextAttemptMicros)}; included in the
                total allowance above.
              </p>
              <p className="mt-2 text-xs text-muted">
                {Date.parse(quote.expiresAt) <= now
                  ? 'This estimate has expired. Refresh it before approving.'
                  : `Review by ${new Date(quote.expiresAt).toLocaleString()}.`}
              </p>
              <p className="mt-2 text-xs text-muted">
                Declining ends only this waiting request. It will not run or spend this allowance.
              </p>
            </>
          ) : null}
          {approved ? (
            <p className="mt-2 text-xs text-muted">
              {grantExpired ? 'Unused allowance expired at' : 'Available until'}{' '}
              {new Date(approved.expiresAt).toLocaleString()}.
              {grantExpired ? ' Previously started work may still finish.' : ''}
            </p>
          ) : null}
          {!approved && request?.status === 'pending' ? (
            <p className="mt-2 text-xs text-muted">
              Awaiting approval is planned cost. It is not reserved or spent.
            </p>
          ) : null}
          {!approved && pending && quote.eligibleHistoricalUnknownMicros > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Approval lets this request proceed while the historical estimates below remain
              unresolved. Spending limits still apply to recorded costs and other committed work.
            </p>
          ) : null}
        </div>
        <BudgetSummary tracking={tracking} />
        {pending && tracking?.complete && !quoteCurrent ? (
          <p role="status" className="mt-2 text-xs text-muted">
            The budget changed after this estimate. Refresh it before approving.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">
          Ceilings when estimated: {formatCostMicros(quote.dailyCeilingMicros)} today and{' '}
          {formatCostMicros(quote.monthlyCeilingMicros)} this month, in UTC periods.
        </p>
        {receipt ? (
          <p role="status" className="mt-3 text-xs text-muted">
            {receipt.status === 'approved'
              ? `Your approval of ${formatCostMicros(receipt.allowanceMicros)} was confirmed.`
              : receipt.status === 'declined'
                ? 'Your decline was confirmed.'
                : 'Your decision was not applied because the estimate changed.'}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Other eligible requests can continue while this request waits.
        </p>
        {unresolved ? (
          <p role="status" className="mt-2 text-xs text-muted">
            Your decision has not been confirmed. Checking it will not send it again.
          </p>
        ) : null}
        {receipt?.status === 'stale' ? (
          <p role="status" className="mt-2 text-xs text-muted">
            That estimate changed before your decision was applied. Review a fresh estimate.
          </p>
        ) : null}
        {!quote.complete || !quote.canApprove ? (
          <p className="mt-2 text-xs text-muted">
            {quote.unavailableReason ??
              'An allowance is unavailable under the current spending limits.'}
          </p>
        ) : null}
        {request?.status === 'unavailable' ? (
          <p className="mt-2 text-xs text-muted">{request.reason}</p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <DecisionActions>
          {pending && !endedHere ? (
            <>
              <ConfirmButton
                key={`${quote.quoteId}:${quote.quoteVersion}`}
                variant="primary"
                size="sm"
                disabled={
                  !canDecide || !canApproveCostQuote(quote, now) || !quoteCurrent || staleHere
                }
                pending={action === 'approve'}
                pendingLabel="Approving…"
                confirmLabel={`Approve ${formatCostMicros(quote.allowanceMicros)}?`}
                onConfirm={() => decide('approve')}
              >
                <Check aria-hidden="true" />
                Approve {formatCostMicros(quote.allowanceMicros)}
              </ConfirmButton>
              <ConfirmButton
                variant="outline"
                size="sm"
                disabled={!canDecide}
                pending={action === 'decline'}
                pendingLabel="Declining…"
                confirmLabel="Decline this request?"
                onConfirm={() => decide('decline')}
              >
                <X aria-hidden="true" />
                Decline
              </ConfirmButton>
            </>
          ) : null}
          {unresolved ? (
            <button
              type="button"
              className={btnSm.outline}
              disabled={!!action}
              onClick={() =>
                void run('reading', async () => {
                  const result = await transport.receipt(part.operationId, unresolved.decisionId);
                  if (!active.current) return;
                  if (!result.ok)
                    throw new Error(
                      'This decision is still unconfirmed. No new decision was sent.',
                    );
                  acceptReceipt(unresolved, result.receipt);
                  await readCurrent();
                })
              }
            >
              Check decision result
            </button>
          ) : null}
          {mayRefresh ? (
            <button
              type="button"
              className={btnSm.outline}
              disabled={!!action}
              onClick={() =>
                void run('refresh', async () => {
                  setTracking(null);
                  const result = await transport.refresh({
                    operationId: part.operationId,
                    quoteRequestId: await costQuoteRefreshId(quote),
                  });
                  if (!active.current) return;
                  if (!result.ok) throw new Error(result.message);
                  setRequest(result.request);
                  setTracking(result.tracking);
                  setReceipt(null);
                })
              }
            >
              <RefreshCw aria-hidden="true" />
              Refresh estimate
            </button>
          ) : null}
          {!unresolved ? (
            <button
              type="button"
              className={btnSm.outline}
              disabled={!!action}
              onClick={() => void run('reading', readCurrent)}
            >
              Check request
            </button>
          ) : null}
        </DecisionActions>
      </div>
    </DecisionCard>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'This request could not be checked.';
}

function BudgetSummary({ tracking }: { tracking: EstimatedCostBudgetTracking | null }) {
  if (!tracking)
    return (
      <div className="mt-3 rounded-xl border border-edge/60 bg-sunken p-3">
        <p role="status" className="text-xs text-muted">
          Current budget tracking is unavailable. Check this request before approving; an
          unavailable amount is not zero.
        </p>
      </div>
    );
  const rows = [
    ['Recorded spending', tracking.recordedDailyMicros, tracking.recordedMonthlyMicros],
    ['Reserved or unresolved', tracking.totalHeldMicros, tracking.totalHeldMicros],
    ['Awaiting approval · planned', tracking.pendingApprovalMicros, tracking.pendingApprovalMicros],
    ['Planned total', tracking.dailyPlannedExposureMicros, tracking.monthlyPlannedExposureMicros],
  ] as const;
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-edge/60 bg-sunken p-3">
      <table className="w-full text-left text-xs tabular-nums">
        <caption className="mb-2 text-left font-medium">
          Budget last checked {new Date(tracking.observedAt).toLocaleTimeString()} · UTC periods
          {tracking.complete ? '' : ' · incomplete'}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-2">
              USD
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              Today
            </th>
            <th scope="col" className="py-1 pl-2 text-right">
              This month
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, daily, monthly]) => (
            <tr key={label} className="border-t border-edge/50">
              <th scope="row" className="py-2 pr-2 font-normal">
                {label}
              </th>
              <td className="px-2 py-2 text-right">
                {daily === null ? 'Unavailable' : formatCostMicros(daily)}
              </td>
              <td className="py-2 pl-2 text-right">
                {monthly === null ? 'Unavailable' : formatCostMicros(monthly)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tracking.historicalUnknownMicros !== null && tracking.historicalUnknownMicros > 0 ? (
        <p className="mt-2 text-xs text-muted">
          Reserved or unresolved includes {formatCostMicros(tracking.historicalUnknownMicros)} in
          historical estimates with an unknown outcome. These are included once and have not been
          cleared or confirmed as charges.
        </p>
      ) : null}
    </div>
  );
}
