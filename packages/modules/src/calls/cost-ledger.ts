import type { RealtimeUsage } from '@assistant/core/realtime-voice';
import type { CallCostComponent, CallCostLedger, CallSession } from '@assistant/persistence';

const RATE_CHECKED_AT = '2026-10-07';
const MEDIA_STREAM_USD_PER_MINUTE = 0.0044;
const AMD_USD_PER_ANSWERED_CALL = 0.0075;

function amount(
  quantity: number,
  unit: string,
  unitPriceUsd: number,
  basis: string,
  model?: string,
  provider?: string,
  rateCheckedAt?: string,
): CallCostComponent {
  return {
    status: 'estimated',
    basis,
    usd: (quantity * unitPriceUsd) / (unit === 'million_tokens' ? 1_000_000 : 1),
    quantity,
    unit,
    unitPriceUsd,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(rateCheckedAt ? { rateCheckedAt } : {}),
  };
}

function unknown(basis: string): CallCostComponent {
  return { status: 'unknown', basis, usd: null };
}

function notApplicable(basis: string): CallCostComponent {
  return { status: 'not_applicable', basis, usd: 0 };
}

function pricedTokenComponent(input: {
  quantity: number;
  rate: number | undefined;
  basis: string;
  model: string;
  provider: string;
  checkedAt: string | undefined;
}): CallCostComponent {
  if (input.quantity <= 0) return notApplicable('provider reported zero usage');
  if (input.rate === undefined || !Number.isFinite(input.rate) || input.rate < 0)
    return unknown(`${input.basis}; no frozen rate for this component`);
  return amount(
    input.quantity,
    'million_tokens',
    input.rate,
    input.basis,
    input.model,
    input.provider,
    input.checkedAt,
  );
}

function sumKnown(components: CallCostLedger['components']): number {
  return Object.values(components).reduce(
    (sum, component) =>
      component.status === 'estimated' || component.status === 'provider_reported'
        ? sum + (component.usd ?? 0)
        : sum,
    0,
  );
}

function isComplete(components: CallCostLedger['components']): boolean {
  return Object.values(components).every(
    (component) =>
      component.status === 'estimated' ||
      component.status === 'provider_reported' ||
      component.status === 'not_applicable' ||
      component.status === 'included_elsewhere',
  );
}

export function refreshCallCostLedger(
  ledger: CallCostLedger,
  components: CallCostLedger['components'],
): CallCostLedger {
  return {
    ...ledger,
    complete: isComplete(components),
    knownSubtotalUsd: Number(sumKnown(components).toFixed(8)),
    components,
  };
}

export function withTwilioPrice(
  ledger: CallCostLedger,
  input: { priceUsd: number | null; answeredBy: string | null; status: string },
): CallCostLedger {
  const components = { ...ledger.components };
  if (input.priceUsd !== null && Number.isFinite(input.priceUsd) && input.priceUsd >= 0) {
    components.carrier = {
      status: 'provider_reported',
      basis: 'Twilio Call Resource price; connectivity only',
      usd: input.priceUsd,
      provider: 'twilio',
    };
  }
  if (input.answeredBy) {
    components.amd = amount(
      1,
      'answered_call',
      AMD_USD_PER_ANSWERED_CALL,
      `published Twilio AMD price; answer verdict ${input.answeredBy}; account invoice not verified`,
      undefined,
      'twilio',
      RATE_CHECKED_AT,
    );
  } else if (['no_answer', 'no-answer', 'busy', 'failed', 'canceled'].includes(input.status)) {
    components.amd = notApplicable('call ended without an answered-party verdict');
  }
  return refreshCallCostLedger(ledger, components);
}

export function closePendingCallCosts(ledger: CallCostLedger, reason: string): CallCostLedger {
  const components = { ...ledger.components };
  for (const name of ['carrier', 'amd'] as const) {
    if (components[name].status === 'pending') components[name] = unknown(reason);
  }
  return refreshCallCostLedger(ledger, components);
}

/**
 * Build a call-scoped ledger. Published rates are estimates; the Twilio Call
 * resource's `price` only covers connectivity. Unmetered shared runtime and
 * late/absent provider usage stay unknown instead of becoming zero.
 */
export function buildCallCostLedger(input: {
  session: CallSession;
  durationSeconds: number | null;
  usage: RealtimeUsage | null;
  carrierPriceUsd?: number | null;
  answeredBy?: string | null;
  callStatus?: string;
  now?: Date;
}): CallCostLedger {
  const now = input.now ?? new Date();
  const route = input.session.voiceRoute;
  const provider = route?.provider ?? 'unknown';
  const model = route?.providerModel ?? input.session.voiceModel;
  const rates = route?.rates;
  const connected = Boolean(input.session.startedAt);
  const seconds = input.durationSeconds;
  const callSid = Boolean(input.session.twilioCallSid);
  const usage = input.usage;

  let carrier: CallCostComponent;
  if (input.carrierPriceUsd !== undefined && input.carrierPriceUsd !== null) {
    carrier = {
      status: 'provider_reported',
      basis: 'Twilio Call Resource price; connectivity only',
      usd: input.carrierPriceUsd,
      provider: 'twilio',
    };
  } else if (callSid) {
    carrier = {
      status: 'pending',
      basis: 'waiting for Twilio connectivity price',
      usd: null,
      provider: 'twilio',
    };
  } else {
    carrier = unknown('no Twilio connectivity receipt is available');
  }

  let mediaStream: CallCostComponent;
  if (!connected) mediaStream = notApplicable('media stream did not connect');
  else if (seconds === null) mediaStream = unknown('connected media duration is missing');
  else
    mediaStream = amount(
      Math.max(0, seconds) / 60,
      'minute',
      MEDIA_STREAM_USD_PER_MINUTE,
      'published Twilio US Media Streams price; estimate from connected seconds',
      undefined,
      'twilio',
      RATE_CHECKED_AT,
    );

  const answeredBy = input.answeredBy ?? input.session.answeredBy;
  let amd: CallCostComponent;
  if (answeredBy) {
    amd = amount(
      1,
      'answered_call',
      AMD_USD_PER_ANSWERED_CALL,
      `published Twilio AMD price; answer verdict ${answeredBy}; account invoice not verified`,
      undefined,
      'twilio',
      RATE_CHECKED_AT,
    );
  } else if (
    ['no_answer', 'no-answer', 'busy', 'failed', 'canceled'].includes(
      input.callStatus ?? input.session.status,
    )
  ) {
    amd = notApplicable('call ended without an answered-party verdict');
  } else if (callSid) {
    amd = {
      status: 'pending',
      basis: 'waiting for asynchronous AMD verdict',
      usd: null,
      provider: 'twilio',
    };
  } else {
    amd = unknown('AMD charge eligibility is not established');
  }

  let modelAudioInput: CallCostComponent;
  let modelAudioOutput: CallCostComponent;
  let modelTextInput: CallCostComponent;
  let modelTextOutput: CallCostComponent;
  let modelCachedInput: CallCostComponent;
  let modelReasoning: CallCostComponent;
  let modelTranscription: CallCostComponent;
  if (!connected) {
    modelAudioInput = notApplicable('voice provider did not connect');
    modelAudioOutput = notApplicable('voice provider did not connect');
    modelTextInput = notApplicable('voice provider did not connect');
    modelTextOutput = notApplicable('voice provider did not connect');
    modelCachedInput = notApplicable('voice provider did not connect');
    modelReasoning = notApplicable('voice provider did not connect');
    modelTranscription = notApplicable('voice provider did not connect');
  } else if (!usage || !rates) {
    modelAudioInput = unknown('provider usage or frozen route rates are missing');
    modelAudioOutput = unknown('provider usage or frozen route rates are missing');
    modelTextInput = unknown('provider usage or frozen route rates are missing');
    modelTextOutput = unknown('provider usage or frozen route rates are missing');
    modelCachedInput = unknown('provider cache usage or frozen cache rate is missing');
    modelReasoning = unknown('provider did not provide separate reasoning usage');
    modelTranscription =
      provider === 'vertex'
        ? {
            status: 'included_elsewhere',
            basis: 'Vertex Live reports transcription within text usage',
            usd: 0,
          }
        : unknown('bridge-measured transcription audio duration is missing');
  } else {
    const unclassifiedCache = usage.cachedUnclassifiedInputTokens;
    modelAudioInput = unclassifiedCache
      ? unknown('cached input is not split by modality; audio input cost cannot be isolated')
      : pricedTokenComponent({
          quantity: Math.max(0, usage.inputAudioTokens - usage.cachedAudioInputTokens),
          rate: rates.audioInputPerMTok,
          basis: 'provider-reported audio tokens × frozen route rate',
          model,
          provider,
          checkedAt: rates.rateCheckedAt,
        });
    modelAudioOutput = pricedTokenComponent({
      quantity: usage.outputAudioTokens,
      rate: rates.audioOutputPerMTok,
      basis: 'provider-reported audio tokens × frozen route rate',
      model,
      provider,
      checkedAt: rates.rateCheckedAt,
    });
    modelTextInput = unclassifiedCache
      ? unknown('cached input is not split by modality; text input cost cannot be isolated')
      : pricedTokenComponent({
          quantity: Math.max(0, usage.inputTextTokens - usage.cachedTextInputTokens),
          rate: rates.textInputPerMTok,
          basis: 'provider-reported text tokens × frozen route rate',
          model,
          provider,
          checkedAt: rates.rateCheckedAt,
        });
    modelTextOutput = pricedTokenComponent({
      quantity: Math.max(0, usage.outputTextTokens - usage.reasoningOutputTokens),
      rate: rates.textOutputPerMTok,
      basis: 'provider-reported response text tokens × frozen route rate',
      model,
      provider,
      checkedAt: rates.rateCheckedAt,
    });
    const cachedQuantities =
      usage.cachedAudioInputTokens + usage.cachedTextInputTokens + unclassifiedCache;
    if (cachedQuantities === 0) {
      modelCachedInput = notApplicable('provider reported no cached input tokens');
    } else if (unclassifiedCache > 0) {
      modelCachedInput = unknown('provider did not identify cached token modality');
    } else if (
      (usage.cachedAudioInputTokens > 0 && rates.cachedAudioInputPerMTok === undefined) ||
      (usage.cachedTextInputTokens > 0 && rates.cachedTextInputPerMTok === undefined)
    ) {
      modelCachedInput = unknown('cached token rate was not frozen with this voice route');
    } else {
      const audioUsd =
        (usage.cachedAudioInputTokens * (rates.cachedAudioInputPerMTok ?? 0)) / 1_000_000;
      const textUsd =
        (usage.cachedTextInputTokens * (rates.cachedTextInputPerMTok ?? 0)) / 1_000_000;
      modelCachedInput = {
        status: 'estimated',
        basis: 'provider-reported cached tokens × frozen modality-specific rate',
        usd: audioUsd + textUsd,
        quantity: cachedQuantities,
        unit: 'tokens',
        provider,
        model,
        ...(rates.rateCheckedAt ? { rateCheckedAt: rates.rateCheckedAt } : {}),
      };
    }
    modelReasoning = usage.reasoningUsageReported
      ? pricedTokenComponent({
          quantity: usage.reasoningOutputTokens,
          rate: rates.textOutputPerMTok,
          basis: 'provider-reported reasoning tokens × text output rate',
          model,
          provider,
          checkedAt: rates.rateCheckedAt,
        })
      : unknown('provider does not separately report reasoning token count');
    const transcriptionMinutes = usage.transcriptionInputAudioMilliseconds / 60_000;
    modelTranscription =
      provider === 'vertex'
        ? {
            status: 'included_elsewhere',
            basis: 'Vertex Live transcription is included in text usage',
            usd: 0,
          }
        : transcriptionMinutes === 0
          ? notApplicable('no caller audio was submitted for transcription')
          : rates.transcriptionUsdPerMinute === undefined
            ? unknown(
                'transcription audio was submitted but no frozen per-minute rate is available',
              )
            : amount(
                transcriptionMinutes,
                'minute',
                rates.transcriptionUsdPerMinute,
                'bridge-measured caller audio sent × frozen GPT-Live-Transcribe published per-minute rate; estimate, not invoice',
                rates.transcriptionModel,
                provider,
                rates.rateCheckedAt,
              );
  }

  const components: CallCostLedger['components'] = {
    carrier,
    mediaStream,
    amd,
    modelAudioInput,
    modelAudioOutput,
    modelTextInput,
    modelTextOutput,
    modelCachedInput,
    modelReasoning,
    modelTranscription,
    backend: notApplicable('call bridge does not invoke a separate backend model'),
    runtime: unknown('shared worker/runtime cost is not attributed per call'),
  };
  return {
    version: 1,
    currency: 'USD',
    createdAt: now.toISOString(),
    complete: isComplete(components),
    knownSubtotalUsd: Number(sumKnown(components).toFixed(8)),
    components,
  };
}

export function finishCostUsd(ledger: CallCostLedger): number | null {
  const invoiceResolved = Object.values(ledger.components).every(
    (component) =>
      component.status === 'provider_reported' ||
      component.status === 'not_applicable' ||
      component.status === 'included_elsewhere',
  );
  return invoiceResolved ? Number(ledger.knownSubtotalUsd.toFixed(6)) : null;
}
