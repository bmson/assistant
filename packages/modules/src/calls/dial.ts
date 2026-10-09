import { randomBytes } from 'node:crypto';
import type { Config } from '@assistant/config';
import {
  BudgetReservationError,
  CALL_RING_ALLOWANCE_MINUTES,
  callDisclosure,
  getRate,
  hashCallbackToken,
  releaseReservation,
  reserveCost,
} from '@assistant/core';
import {
  type ResolvedVoiceModel,
  realtimeEstimatePerMinuteUsd,
} from '@assistant/core/realtime-voice';
import type {
  CallSessionRepository,
  CallVoiceRouteSnapshot,
  CostRepository,
} from '@assistant/persistence';
import {
  AmbiguousTwilioDeliveryError,
  isAmbiguousTwilioDeliveryError,
  outboundCallTwiml,
  type StartCallInput,
  type VoiceDialer,
} from '@assistant/tools/calls';

export interface DialDeps {
  config: Pick<Config, 'PUBLIC_URL' | 'OWNER_NAME' | 'CALL_DAILY_LIMIT' | 'CALL_MAX_MINUTES'>;
  calls: CallSessionRepository;
  costs: CostRepository;
  dialer: VoiceDialer;
  /** The owner the call belongs to. */
  ownerId(): Promise<string>;
  /** The configured voice model (throws with an owner-readable reason when none). */
  voiceModel(): Promise<{
    id: string;
    resolved: ResolvedVoiceModel;
    route: CallVoiceRouteSnapshot;
  }>;
}

export class CallRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallRefusedError';
  }
}

/** wss:// form of the agent's public URL, where Twilio opens the media stream. */
export function mediaStreamUrl(publicUrl: string): string {
  const url = new URL('/voice/stream', publicUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

/**
 * Everything between an approved `phone.call` and a ringing phone: the caps,
 * the voice model, the budget hold, the session row, and the dial itself.
 */
export async function startCall(
  deps: DialDeps,
  input: StartCallInput,
): Promise<{ callSid: string }> {
  if (!deps.dialer.configured())
    throw new CallRefusedError('Phone calls are not set up yet (run pnpm setup:phone).');
  const agentId = await deps.ownerId();
  const voice = await deps.voiceModel();
  const brief = input.brief;
  const minutes = Math.min(brief.maxMinutes, deps.config.CALL_MAX_MINUTES);

  // Hold the worst case — every allowed minute of line time and live model —
  // before anything rings. The hold is reconciled to actual use at the end.
  const lineRate = await getRate(deps.costs, 'twilio_voice_min');
  const estimatedUsd =
    minutes * (lineRate.unitPriceUsd + realtimeEstimatePerMinuteUsd(voice.resolved.rates));
  const reservation = await reserveCost(deps.costs, {
    source: 'twilio_voice_min',
    estimatedUsd,
    taskId: input.ctx.taskId,
    description: `phone call to ${brief.to} (up to ${minutes} min)`,
  });
  if (!reservation.ok) throw new BudgetReservationError(reservation.reason, reservation.resumeAt);

  const streamToken = randomBytes(24).toString('hex');
  try {
    const admission = await deps.calls.admit(
      {
        id: input.callId,
        agentId,
        taskId: input.ctx.taskId,
        toolCallId: input.ctx.execution.dbToolCallId,
        status: 'dialing',
        to: brief.to,
        contactName: brief.contactName ?? null,
        brief: { ...brief, maxMinutes: minutes },
        voiceModel: voice.id,
        voiceRoute: voice.route,
        lineRate,
        maxMinutes: minutes,
        streamTokenHash: hashCallbackToken(streamToken),
        callbackToken: input.callbackToken,
        reservationId: reservation.reservationId,
      },
      { now: input.ctx.now(), dailyLimit: deps.config.CALL_DAILY_LIMIT },
    );
    if (admission.kind === 'active_limit')
      throw new CallRefusedError('Another call is still in progress; try again when it ends.');
    if (admission.kind === 'daily_limit')
      throw new CallRefusedError(
        `The daily limit of ${deps.config.CALL_DAILY_LIMIT} calls has been reached (CALL_DAILY_LIMIT).`,
      );
    if (admission.kind === 'existing') {
      if (admission.call.twilioCallSid) {
        await releaseReservation(deps.costs, reservation.reservationId);
        return { callSid: admission.call.twilioCallSid };
      }
      if (admission.call.capacityReleasedAt)
        throw new CallRefusedError(
          'The prior call attempt was refused; start a new request to try again.',
        );
      throw new AmbiguousTwilioDeliveryError(
        'The existing call admission may already have dialed; waiting for its outcome.',
      );
    }
  } catch (error) {
    await releaseReservation(deps.costs, reservation.reservationId).catch(() => {});
    throw error;
  }

  const statusUrl = new URL('/webhooks/twilio/voice-status', deps.config.PUBLIC_URL).toString();
  let acceptedCallSid: string | undefined;
  try {
    const { sid } = await deps.dialer.placeCall({
      to: brief.to,
      twiml: outboundCallTwiml({
        disclosure: callDisclosure(deps.config.OWNER_NAME),
        streamUrl: mediaStreamUrl(deps.config.PUBLIC_URL),
        callId: input.callId,
        streamToken,
      }),
      statusCallback: statusUrl,
      asyncAmdStatusCallback: statusUrl,
      // The disclosure plays before the minutes start counting for the model.
      timeLimitSeconds: minutes * 60 + 20,
    });
    acceptedCallSid = sid;
    await deps.calls.update(input.callId, { twilioCallSid: sid });
    return { callSid: sid };
  } catch (error) {
    if (acceptedCallSid)
      throw new AmbiguousTwilioDeliveryError(
        'The provider accepted the call but its receipt could not be saved; waiting for its outcome.',
        error,
      );
    if (!isAmbiguousTwilioDeliveryError(error)) {
      await deps.calls
        .finish(input.callId, { status: 'failed', error: String(error), endedAt: new Date() })
        .catch(() => {});
      await deps.calls.releaseAdmission(input.callId, input.ctx.now()).catch(() => {});
      await releaseReservation(deps.costs, reservation.reservationId).catch(() => {});
    }
    throw error;
  }
}

/** Calls a crash or a lost callback left "active" long after they must have ended. */
export function staleCallCutoff(now: Date, maxMinutes: number): Date {
  return new Date(now.getTime() - (maxMinutes + CALL_RING_ALLOWANCE_MINUTES + 10) * 60_000);
}
