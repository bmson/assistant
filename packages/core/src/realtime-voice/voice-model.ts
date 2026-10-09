import type { Config } from '@assistant/config';
import type { Records } from '@assistant/persistence';
import { decryptStoredCredential } from '../mcp-secrets.js';
import { connectionIdForModel } from '../model-router/connections.js';
import { createGeminiLiveProvider } from './gemini.js';
import { createOpenAIRealtimeProvider } from './openai.js';
import type { RealtimeUsage, RealtimeVoiceProvider } from './types.js';

/**
 * The voice model is the catalog row the `voice` role points at, served by the
 * same owner-connected providers as the text models. Voice rows carry audio
 * rates in `capabilities` because audio and text tokens are priced apart.
 */
export interface VoiceModelCapabilities {
  realtime: true;
  /** USD per million audio input tokens (the other party's speech). */
  audioInputPerMTok: number;
  /** USD per million audio output tokens (the assistant's speech). */
  audioOutputPerMTok: number;
  /** Present only when the provider's cached-input rate is known for this model. */
  cachedAudioInputPerMTok?: number;
  cachedTextInputPerMTok?: number;
  /** Provider voice name, e.g. "marin" or "Aoede". */
  voice?: string;
}

export function voiceCapabilities(model: Records['models'] | null): VoiceModelCapabilities | null {
  const caps = (model?.capabilities ?? {}) as Partial<VoiceModelCapabilities>;
  if (
    caps.realtime !== true ||
    !Number.isFinite(caps.audioInputPerMTok) ||
    !Number.isFinite(caps.audioOutputPerMTok)
  )
    return null;
  return caps as VoiceModelCapabilities;
}

export interface ResolvedVoiceModel {
  provider: RealtimeVoiceProvider;
  /** The provider's own model name. */
  model: string;
  voice?: string;
  rates: {
    audioInputPerMTok: number;
    audioOutputPerMTok: number;
    textInputPerMTok: number;
    textOutputPerMTok: number;
    cachedAudioInputPerMTok?: number;
    cachedTextInputPerMTok?: number;
    transcriptionUsdPerMinute?: number;
    transcriptionModel?: string;
    rateCheckedAt?: string;
  };
}

export class VoiceModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelUnavailableError';
  }
}

/** Build the live-session provider for a catalog voice model. */
export function resolveVoiceModel(input: {
  model: Records['models'] | null;
  connections: readonly Records['modelConnections'][];
  config: Pick<Config, 'VERTEX_PROJECT' | 'VERTEX_LOCATION'>;
  decrypt?: (sealed: string) => string;
  /** Preserve an in-flight call's saved provider selection. */
  transcriptionModel?: string;
}): ResolvedVoiceModel {
  const row = input.model;
  const caps = voiceCapabilities(row);
  if (!row?.enabled || !caps)
    throw new VoiceModelUnavailableError(
      'No voice model is set up. Choose one in Settings → AI providers.',
    );
  const decrypt = input.decrypt ?? decryptStoredCredential;
  const transcriptionModel = input.transcriptionModel ?? 'gpt-live-transcribe';
  const connectionId = connectionIdForModel(row.id);
  const connection = input.connections.find((candidate) => candidate.id === connectionId);
  if (connection && !connection.enabled)
    throw new VoiceModelUnavailableError(`The ${connection.label} connection is turned off.`);
  const rates = {
    audioInputPerMTok: caps.audioInputPerMTok,
    audioOutputPerMTok: caps.audioOutputPerMTok,
    textInputPerMTok: Number(row.promptCostPerMTok ?? 0),
    textOutputPerMTok: Number(row.completionCostPerMTok ?? 0),
    ...(typeof caps.cachedAudioInputPerMTok === 'number'
      ? { cachedAudioInputPerMTok: caps.cachedAudioInputPerMTok }
      : {}),
    ...(typeof caps.cachedTextInputPerMTok === 'number'
      ? { cachedTextInputPerMTok: caps.cachedTextInputPerMTok }
      : {}),
    ...(row.id.startsWith('openai:') && transcriptionModel === 'gpt-live-transcribe'
      ? {
          transcriptionUsdPerMinute: 0.017,
          transcriptionModel,
          rateCheckedAt: '2026-10-07',
        }
      : row.id.startsWith('openai:')
        ? { transcriptionModel }
        : {}),
  };
  if (row.id.startsWith('openai:')) {
    const key = connection?.apiKeyEncrypted ? decrypt(connection.apiKeyEncrypted) : '';
    if (!key)
      throw new VoiceModelUnavailableError(
        'Connect OpenAI with an API key in Settings → AI providers to use this voice model.',
      );
    return {
      provider: createOpenAIRealtimeProvider({ apiKey: key, transcriptionModel }),
      model: row.id.slice('openai:'.length),
      voice: caps.voice,
      rates,
    };
  }
  if (/^vertex[:/]/.test(row.id)) {
    const project = connection?.vertexProject || input.config.VERTEX_PROJECT;
    const location = connection?.vertexLocation || input.config.VERTEX_LOCATION;
    if (!project || !location)
      throw new VoiceModelUnavailableError(
        'Connect Google Vertex AI in Settings → AI providers to use this voice model.',
      );
    return {
      provider: createGeminiLiveProvider({ project, location }),
      model: row.id.replace(/^vertex[:/]/, ''),
      voice: caps.voice,
      rates,
    };
  }
  throw new VoiceModelUnavailableError(
    `${row.label} is not a supported live voice model (OpenAI Realtime or Gemini Live).`,
  );
}

/** Actual model spend for a finished call. */
export function realtimeCostUsd(usage: RealtimeUsage, rates: ResolvedVoiceModel['rates']): number {
  const modelTokens =
    Math.max(0, usage.inputAudioTokens - usage.cachedAudioInputTokens) * rates.audioInputPerMTok +
    Math.max(0, usage.inputTextTokens - usage.cachedTextInputTokens) * rates.textInputPerMTok +
    usage.cachedAudioInputTokens * (rates.cachedAudioInputPerMTok ?? rates.audioInputPerMTok) +
    usage.cachedTextInputTokens * (rates.cachedTextInputPerMTok ?? rates.textInputPerMTok) +
    usage.outputAudioTokens * rates.audioOutputPerMTok +
    usage.outputTextTokens * rates.textOutputPerMTok;
  const transcription =
    (usage.transcriptionInputAudioMilliseconds * (rates.transcriptionUsdPerMinute ?? 0)) / 60_000;
  return (modelTokens + transcription) / 1_000_000;
}

/**
 * A deliberately high per-minute estimate for the budget hold. Realtime APIs
 * re-bill the whole conversation on every turn, so input grows with call
 * length; 6k input and 1.5k output tokens a minute covers a busy call.
 */
export function realtimeEstimatePerMinuteUsd(rates: ResolvedVoiceModel['rates']): number {
  return (6_000 * rates.audioInputPerMTok + 1_500 * rates.audioOutputPerMTok) / 1_000_000;
}
