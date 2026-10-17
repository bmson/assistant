import { describe, expect, it } from 'vitest';
import { emptyRealtimeUsage } from './types.js';
import { realtimeCostUsd, realtimeEstimatePerMinuteUsd } from './voice-model.js';

const rates = {
  audioInputPerMTok: 8,
  audioOutputPerMTok: 32,
  textInputPerMTok: 4,
  textOutputPerMTok: 16,
  cachedAudioInputPerMTok: 2,
  cachedTextInputPerMTok: 1,
  transcriptionUsdPerMinute: 0.017,
};

describe('realtimeCostUsd', () => {
  it('adds transcription dollars to token-rate dollars without rescaling them', () => {
    const usage = {
      ...emptyRealtimeUsage(),
      inputAudioTokens: 10_000,
      cachedAudioInputTokens: 4_000,
      inputTextTokens: 2_000,
      cachedTextInputTokens: 500,
      outputAudioTokens: 1_000,
      outputTextTokens: 500,
      transcriptionInputAudioMilliseconds: 60_000,
    };

    // Token cost: $0.1025. One minute of transcription: $0.017.
    expect(realtimeCostUsd(usage, rates)).toBeCloseTo(0.1195, 12);
  });

  it('prices a partial transcription minute proportionally', () => {
    const usage = {
      ...emptyRealtimeUsage(),
      transcriptionInputAudioMilliseconds: 30_000,
    };

    expect(realtimeCostUsd(usage, rates)).toBeCloseTo(0.0085, 12);
  });

  it('adds no transcription charge when no per-minute rate is frozen', () => {
    const usage = {
      ...emptyRealtimeUsage(),
      transcriptionInputAudioMilliseconds: 60_000,
    };
    const { transcriptionUsdPerMinute: _unused, ...ratesWithoutTranscription } = rates;

    expect(realtimeCostUsd(usage, ratesWithoutTranscription)).toBe(0);
  });
});

describe('realtimeEstimatePerMinuteUsd', () => {
  it('adds the frozen transcription rate to the model-token estimate', () => {
    expect(realtimeEstimatePerMinuteUsd(rates)).toBeCloseTo(0.113, 12);
  });

  it('treats a zero or missing transcription rate as no additional estimate', () => {
    const { transcriptionUsdPerMinute: _unused, ...ratesWithoutTranscription } = rates;

    expect(realtimeEstimatePerMinuteUsd({ ...rates, transcriptionUsdPerMinute: 0 })).toBeCloseTo(
      0.096,
      12,
    );
    expect(realtimeEstimatePerMinuteUsd(ratesWithoutTranscription)).toBeCloseTo(0.096, 12);
  });
});
