import {
  type CallResult,
  getRate,
  reconcileReservation,
  recordCallResult,
  recordCostEvent,
} from '@assistant/core';
import { connectionIdForModel } from '@assistant/core/model-router';
import type { RealtimeUsage } from '@assistant/core/realtime-voice';
import type {
  CallFinishDelivery,
  CallSession,
  CallSessionRepository,
  CallTranscriptLine,
  CostRepository,
  ExecutionJobRepository,
} from '@assistant/persistence';
import { isCallFinishDelivery } from '@assistant/persistence';
import type { VoiceDialer } from '@assistant/tools/calls';
import {
  buildCallCostLedger,
  closePendingCallCosts,
  finishCostUsd,
  withTwilioPrice,
} from './cost-ledger.js';

export interface FinishDeps {
  calls: CallSessionRepository;
  costs: CostRepository;
  jobs: ExecutionJobRepository;
  dialer?: VoiceDialer;
}

export interface FinishInput {
  status: 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled';
  outcome: CallResult['outcome'];
  summary: string;
  /** Connected seconds, as Twilio or the bridge measured them. */
  durationSeconds: number | null;
  /** Legacy model estimate; new call ledgers price each reported component. */
  modelCostUsd: number;
  /** Provider usage is retained by component and priced against the frozen route. */
  usage?: RealtimeUsage | null;
  /** Late Twilio receipts may arrive after the bridge has begun finishing. */
  carrierPriceUsd?: number | null;
  answeredBy?: string | null;
  error?: string | null;
}

function resultFromDelivery(delivery: CallFinishDelivery): CallResult {
  return delivery.result as CallResult;
}

async function deferDelivery(deps: FinishDeps, session: CallSession): Promise<void> {
  await deps.calls
    .deferFinishDelivery(session.id)
    .catch((error) => console.error('call finish retry scheduling failed', error));
}

/** Replay only durable post-call work. Cost operations and the job callback have stable identities. */
export async function deliverCallFinish(deps: FinishDeps, session: CallSession): Promise<boolean> {
  let delivery = isCallFinishDelivery(session.finishDelivery) ? session.finishDelivery : null;
  if (!delivery) return false;
  let costReceiptPending = false;

  if (!delivery.costs.done) {
    try {
      if (delivery.costs.ledger) {
        let ledger = delivery.costs.ledger;
        const carrierPending = ledger.components.carrier.status === 'pending';
        const amdPending = ledger.components.amd.status === 'pending';
        if ((carrierPending || amdPending) && deps.dialer && session.twilioCallSid) {
          const details = await deps.dialer.getCall(session.twilioCallSid).catch(() => null);
          if (details) {
            ledger = withTwilioPrice(ledger, {
              priceUsd: details.priceUsd,
              answeredBy: details.answeredBy,
              status: details.status,
            });
          }
        }
        const waitingForReceipt =
          ledger.components.carrier.status === 'pending' ||
          ledger.components.amd.status === 'pending';
        const canReconcileLate = Boolean(deps.dialer && session.twilioCallSid);
        if (waitingForReceipt && canReconcileLate && delivery.attempts < 8) {
          costReceiptPending = true;
        }
        if (waitingForReceipt && !costReceiptPending)
          ledger = closePendingCallCosts(
            ledger,
            'provider receipt did not settle before the bounded reconciliation window ended',
          );
        if (JSON.stringify(ledger) !== JSON.stringify(delivery.costs.ledger)) {
          await deps.calls.updateFinishCostLedger(session.id, ledger, finishCostUsd(ledger));
          const refreshed = await deps.calls.get(session.id);
          const next =
            refreshed && isCallFinishDelivery(refreshed.finishDelivery)
              ? refreshed.finishDelivery
              : null;
          if (next) delivery = next;
        }
        if (!costReceiptPending) {
          const usd = ledger.knownSubtotalUsd;
          if (delivery.costs.twilio.reservationId) {
            await reconcileReservation(deps.costs, delivery.costs.twilio.reservationId, {
              usd,
              quantity: delivery.costs.twilio.minutes,
              unit: delivery.costs.twilio.unit,
              unitPriceUsd: delivery.costs.twilio.unitPriceUsd,
              description: `voice call to ${session.to}; component ledger attached`,
              evidence: {
                basis: 'component_ledger',
                provider: 'twilio',
                model: delivery.costs.model.model,
                voiceCallLedger: ledger,
              },
            });
          } else if (usd > 0) {
            await deps.costs.record({
              source: 'twilio_voice_min',
              usd,
              quantity: delivery.costs.twilio.minutes,
              unit: delivery.costs.twilio.unit,
              unitPriceUsd: delivery.costs.twilio.unitPriceUsd,
              taskId: session.taskId,
              description: `voice call to ${session.to}; component ledger attached`,
              idempotencyKey: delivery.costs.twilio.idempotencyKey,
              addToTaskSpend: true,
              evidence: {
                basis: 'component_ledger',
                provider: 'twilio',
                model: delivery.costs.model.model,
                voiceCallLedger: ledger,
              },
            });
          }
          if (!(await deps.calls.markFinishDelivery(session.id, 'costs')))
            throw new Error('call cost outbox acknowledgement failed');
        }
      } else {
        const twilio = delivery.costs.twilio;
        if (twilio.reservationId) {
          await reconcileReservation(deps.costs, twilio.reservationId, {
            usd: twilio.usd,
            quantity: twilio.minutes,
            unit: twilio.unit,
            unitPriceUsd: twilio.unitPriceUsd,
            description: `phone call to ${session.to} (${twilio.minutes} min)`,
          });
        } else if (twilio.usd > 0) {
          await deps.costs.record({
            source: 'twilio_voice_min',
            usd: twilio.usd,
            quantity: twilio.minutes,
            unit: twilio.unit,
            unitPriceUsd: twilio.unitPriceUsd,
            taskId: session.taskId,
            description: `phone call to ${session.to} (${twilio.minutes} min)`,
            idempotencyKey: twilio.idempotencyKey,
            addToTaskSpend: true,
          });
        }
        const model = delivery.costs.model;
        if (model.usd > 0) {
          await recordCostEvent(deps.costs, {
            source: 'model',
            evidence: { basis: 'token_rate', provider: model.provider, model: model.model },
            usd: model.usd,
            taskId: session.taskId,
            description: `live voice model ${model.model} on a phone call`,
            idempotencyKey: model.idempotencyKey,
            addToTaskSpend: true,
          });
        }
        if (!(await deps.calls.markFinishDelivery(session.id, 'costs')))
          throw new Error('call cost outbox acknowledgement failed');
      }
    } catch (error) {
      console.error('call cost reconciliation failed; delivery remains pending', error);
      await deferDelivery(deps, session);
      return false;
    }
  }

  if (!delivery.resultDelivered) {
    try {
      const woke = await recordCallResult(deps.jobs, {
        taskId: session.taskId,
        token: session.callbackToken,
        result: resultFromDelivery(delivery),
      });
      if (!woke.ok) {
        console.error('call result could not wake its task', woke.status, woke.error);
        await deferDelivery(deps, session);
        return false;
      }
      if (!(await deps.calls.markFinishDelivery(session.id, 'result')))
        throw new Error('call result outbox acknowledgement failed');
    } catch (error) {
      console.error('call result delivery failed; delivery remains pending', error);
      await deferDelivery(deps, session);
      return false;
    }
  }
  if (costReceiptPending) {
    await deferDelivery(deps, session);
    return false;
  }
  return true;
}

/**
 * Persist the winning terminal outcome before attempting cost or callback work.
 * A retry can replay this immutable snapshot without repeating the telephone call.
 */
export async function finishCall(
  deps: FinishDeps,
  session: CallSession,
  input: FinishInput,
): Promise<CallResult | null> {
  const current = (await deps.calls.get(session.id)) ?? session;
  if (isCallFinishDelivery(current.finishDelivery)) {
    await deliverCallFinish(deps, current);
    const refreshed = (await deps.calls.get(current.id)) ?? current;
    return resultFromDelivery(refreshed.finishDelivery as CallFinishDelivery);
  }
  const minutes = input.durationSeconds ? Math.ceil(input.durationSeconds / 60) : 0;
  // New calls freeze this price before reserving and dialing. Legacy rows may
  // still need the current table once; a failure there leaves them retryable.
  const frozenRate = current.lineRate;
  const rate =
    frozenRate &&
    typeof frozenRate.unit === 'string' &&
    Number.isFinite(frozenRate.unitPriceUsd) &&
    frozenRate.unitPriceUsd >= 0
      ? frozenRate
      : await getRate(deps.costs, 'twilio_voice_min');
  const twilioUsd = minutes * rate.unitPriceUsd;
  const fresh = current;
  const transcript = ((fresh.transcript as CallTranscriptLine[]) ?? []).map((line) => ({
    role: line.role === 'caller' ? 'them' : line.role,
    text: line.text,
  }));
  const ledger = buildCallCostLedger({
    session: fresh,
    durationSeconds: input.durationSeconds,
    usage: input.usage ?? null,
    carrierPriceUsd: input.carrierPriceUsd,
    answeredBy: input.answeredBy,
    callStatus: input.status,
  });
  const result: CallResult = {
    callId: fresh.id,
    to: fresh.to,
    status: input.status,
    outcome: input.outcome,
    summary: input.summary.slice(0, 2_000),
    notes: (fresh.notes as string[]) ?? [],
    durationSeconds: input.durationSeconds,
    transcript: transcript.slice(-80),
    costUsd: finishCostUsd(ledger),
    costBreakdown: ledger,
  };
  const delivery: CallFinishDelivery = {
    version: 1,
    attempts: 0,
    nextAttemptAt: new Date(),
    result,
    costs: {
      done: false,
      ledger,
      twilio: {
        reservationId: fresh.reservationId,
        idempotencyKey: `call:${fresh.id}:twilio`,
        usd: twilioUsd,
        minutes,
        unit: rate.unit,
        unitPriceUsd: rate.unitPriceUsd,
      },
      model: {
        idempotencyKey: `call:${fresh.id}:model`,
        usd: input.modelCostUsd,
        provider: connectionIdForModel(fresh.voiceModel),
        model: fresh.voiceModel,
      },
    },
    resultDelivered: false,
  };
  const finished = await deps.calls.finish(fresh.id, {
    status: input.status,
    outcome: input.outcome,
    summary: input.summary.slice(0, 2_000),
    durationSeconds: input.durationSeconds,
    endedAt: new Date(),
    costUsd: result.costUsd === null ? null : result.costUsd.toFixed(6),
    error: input.error ?? null,
    finishDelivery: delivery,
  });
  if (!finished) {
    // A concurrent webhook or bridge may have won. Deliver only the terminal
    // snapshot it committed; never replace it with this caller's stale inputs.
    const winner = await deps.calls.get(fresh.id);
    if (winner) await deliverCallFinish(deps, winner);
    return null;
  }

  await deliverCallFinish(deps, finished);
  const refreshed = (await deps.calls.get(fresh.id)) ?? finished;
  return resultFromDelivery(refreshed.finishDelivery as CallFinishDelivery);
}

/** Map a terminal Twilio call status onto our own. */
export function terminalStatus(twilioStatus: string): FinishInput['status'] | null {
  switch (twilioStatus) {
    case 'completed':
      return 'completed';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}
