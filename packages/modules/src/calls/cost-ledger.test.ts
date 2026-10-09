import { type CallSession, isCallCostLedger } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  buildCallCostLedger,
  closePendingCallCosts,
  finishCostUsd,
  withTwilioPrice,
} from './cost-ledger.js';

const session = {
  id: 'call-1',
  agentId: 'agent-1',
  to: '+15555550123',
  status: 'completed',
  voiceModel: 'gpt-realtime-2.1',
  twilioCallSid: 'CA-test',
  answeredBy: 'human',
  startedAt: new Date('2026-10-07T10:00:00Z'),
  voiceRoute: {
    version: 1,
    modelId: 'gpt-realtime-2.1',
    connectionId: 'openai',
    connectionKind: 'openai',
    connectionUpdatedAt: null,
    provider: 'openai',
    providerModel: 'gpt-realtime-2.1',
    endpoint: { kind: 'openai-realtime', url: 'wss://api.openai.com/v1/realtime' },
    voice: null,
    rates: {
      audioInputPerMTok: 32,
      audioOutputPerMTok: 64,
      textInputPerMTok: 4,
      textOutputPerMTok: 24,
      cachedAudioInputPerMTok: 0.4,
      cachedTextInputPerMTok: 0.4,
      transcriptionUsdPerMinute: 0.017,
      transcriptionModel: 'gpt-live-transcribe',
      rateCheckedAt: '2026-10-07',
    },
  },
} as unknown as CallSession;

const usage = {
  inputAudioTokens: 1_000_000,
  inputTextTokens: 500_000,
  cachedInputTokens: 200_000,
  cachedAudioInputTokens: 100_000,
  cachedTextInputTokens: 100_000,
  cachedUnclassifiedInputTokens: 0,
  outputAudioTokens: 100_000,
  outputTextTokens: 50_000,
  reasoningOutputTokens: 10_000,
  reasoningUsageReported: true,
  transcriptionInputAudioTokens: 1_000_000,
  transcriptionOutputTextTokens: 20_000,
  transcriptionUsageReported: true,
  transcriptionInputAudioMilliseconds: 60_000,
};

describe('voice call cost component ledger', () => {
  it('separates metered carrier, media, AMD, modality, cache, reasoning, and transcription costs', () => {
    const ledger = buildCallCostLedger({
      session,
      durationSeconds: 120,
      usage,
      carrierPriceUsd: 0.03,
      answeredBy: 'human',
      now: new Date('2026-10-07T10:02:00Z'),
    });

    expect(ledger.components.carrier).toMatchObject({ status: 'provider_reported', usd: 0.03 });
    expect(ledger.components.carrier.basis).toContain('connectivity only');
    expect(ledger.components.mediaStream).toMatchObject({ status: 'estimated', usd: 0.0088 });
    expect(ledger.components.amd).toMatchObject({ status: 'estimated', usd: 0.0075 });
    expect(ledger.components.modelAudioInput.usd).toBeCloseTo(28.8);
    expect(ledger.components.modelAudioOutput.usd).toBeCloseTo(6.4);
    expect(ledger.components.modelTextInput.usd).toBeCloseTo(1.6);
    expect(ledger.components.modelTextOutput.usd).toBeCloseTo(0.96);
    expect(ledger.components.modelCachedInput.usd).toBeCloseTo(0.08);
    expect(ledger.components.modelReasoning.usd).toBeCloseTo(0.24);
    expect(ledger.components.modelTranscription.usd).toBeCloseTo(0.017);
    expect(ledger.components.runtime).toMatchObject({ status: 'unknown', usd: null });
    expect(ledger.complete).toBe(false);
    expect(ledger.knownSubtotalUsd).toBeCloseTo(38.1433);
    expect(isCallCostLedger(ledger)).toBe(true);
    expect(
      isCallCostLedger({ ...ledger, components: { ...ledger.components, carrier: null } }),
    ).toBe(false);
    expect(finishCostUsd(ledger)).toBeNull();
    const resolved = {
      ...ledger,
      components: {
        ...ledger.components,
        runtime: { status: 'not_applicable' as const, basis: 'test', usd: 0 },
      },
      complete: true,
    };
    expect(finishCostUsd(resolved)).toBeNull(); // published rates remain estimates, not an invoice
  });

  it('keeps late carrier charges pending and applies a later provider receipt once', () => {
    const pending = buildCallCostLedger({ session, durationSeconds: 60, usage, now: new Date() });
    expect(pending.components.carrier.status).toBe('pending');
    const settled = withTwilioPrice(pending, {
      priceUsd: 0.014,
      answeredBy: 'machine_start',
      status: 'completed',
    });
    const repeated = withTwilioPrice(settled, {
      priceUsd: 0.014,
      answeredBy: 'machine_start',
      status: 'completed',
    });
    expect(settled.components.carrier).toMatchObject({ status: 'provider_reported', usd: 0.014 });
    expect(repeated.knownSubtotalUsd).toBe(settled.knownSubtotalUsd);
    expect(settled.components.amd.usd).toBe(0.0075);
  });

  it('turns unresolved asynchronous receipts into explicit unknowns after bounded reconciliation', () => {
    const pending = buildCallCostLedger({
      session: { ...session, answeredBy: null } as CallSession,
      durationSeconds: 60,
      usage: null,
    });
    const closed = closePendingCallCosts(pending, 'bounded lookup ended');
    expect(closed.components.carrier).toMatchObject({ status: 'unknown', usd: null });
    expect(closed.components.amd).toMatchObject({ status: 'unknown', usd: null });
    expect(closed.complete).toBe(false);
    expect(finishCostUsd(closed)).toBeNull();
  });
});
