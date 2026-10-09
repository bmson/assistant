import type { Config } from '@assistant/config';
import { connectionIdForModel } from '@assistant/core/model-router';
import {
  type ResolvedVoiceModel,
  resolveVoiceModel,
  VoiceModelUnavailableError,
} from '@assistant/core/realtime-voice';
import type {
  CallSession,
  CallVoiceRouteSnapshot,
  ExecutionPersistence,
} from '@assistant/persistence';
import { isCallVoiceRouteSnapshot } from '@assistant/persistence';

type VoiceConfig = Pick<Config, 'VERTEX_PROJECT' | 'VERTEX_LOCATION'>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export function snapshotVoiceRoute(input: {
  modelId: string;
  model: Parameters<typeof resolveVoiceModel>[0]['model'];
  connections: Parameters<typeof resolveVoiceModel>[0]['connections'];
  config: VoiceConfig;
  resolved: ResolvedVoiceModel;
}): CallVoiceRouteSnapshot {
  const connectionId = connectionIdForModel(input.modelId);
  const connection = input.connections.find((candidate) => candidate.id === connectionId);
  if (connectionId !== 'openai' && connectionId !== 'vertex')
    throw new VoiceModelUnavailableError('This connection cannot serve a live voice call.');
  const connectionKind = connectionId;
  let endpoint: CallVoiceRouteSnapshot['endpoint'];
  if (connectionId === 'openai') {
    endpoint = { kind: 'openai-realtime', url: 'wss://api.openai.com/v1/realtime' };
  } else {
    const project = connection?.vertexProject || input.config.VERTEX_PROJECT;
    const location = connection?.vertexLocation || input.config.VERTEX_LOCATION;
    if (!project || !location)
      throw new VoiceModelUnavailableError('The live voice endpoint is not configured.');
    endpoint = { kind: 'vertex-live', project, location };
  }
  const model = input.model;
  if (!model?.enabled)
    throw new VoiceModelUnavailableError('The selected live voice model is no longer enabled.');
  return {
    version: 1,
    modelId: input.modelId,
    connectionId,
    connectionKind,
    connectionUpdatedAt: connection?.updatedAt ? connection.updatedAt.toISOString() : null,
    provider: connectionId,
    providerModel: input.resolved.model,
    endpoint,
    voice: input.resolved.voice ?? null,
    rates: { ...input.resolved.rates },
  };
}

export async function selectVoiceRoute(
  persistence: ExecutionPersistence,
  config: VoiceConfig,
): Promise<{ id: string; resolved: ResolvedVoiceModel; route: CallVoiceRouteSnapshot }> {
  const role = await persistence.modelRouting.role('voice');
  if (!role)
    throw new VoiceModelUnavailableError(
      'No voice model is set up. Choose one in Settings → AI providers.',
    );
  const [model, connections] = await Promise.all([
    persistence.modelRouting.model(role.primaryModel),
    persistence.modelConnections?.list() ?? Promise.resolve([]),
  ]);
  const resolved = resolveVoiceModel({ model, connections, config });
  return {
    id: role.primaryModel,
    resolved,
    route: snapshotVoiceRoute({
      modelId: role.primaryModel,
      model,
      connections,
      config,
      resolved,
    }),
  };
}

/** Resolve the persisted route; never consult the mutable voice role. */
export async function resolveSessionVoiceRoute(
  session: Pick<CallSession, 'voiceRoute'>,
  persistence: ExecutionPersistence,
  config: VoiceConfig,
): Promise<ResolvedVoiceModel> {
  const route = session.voiceRoute;
  if (!isCallVoiceRouteSnapshot(route))
    throw new VoiceModelUnavailableError(
      'This call has no saved voice route and cannot safely connect. End it and place a new call.',
    );
  const [model, connections] = await Promise.all([
    persistence.modelRouting.model(route.modelId),
    persistence.modelConnections?.list() ?? Promise.resolve([]),
  ]);
  const resolved = resolveVoiceModel({
    model,
    connections,
    config,
    // Older saved calls keep the transcription model they were created with;
    // new calls use the currently supported default.
    transcriptionModel:
      route.provider === 'openai'
        ? (route.rates.transcriptionModel ?? 'gpt-4o-mini-transcribe')
        : undefined,
  });
  const current = snapshotVoiceRoute({
    modelId: route.modelId,
    model,
    connections,
    config,
    resolved,
  });
  // Legacy v1 calls did not snapshot transcription/cache prices. Compare
  // their original keys only, while the explicit saved transcriber above
  // keeps their provider contract stable. Newly created routes compare all
  // fields exactly.
  const compatibleLegacyRoute =
    route.provider === 'openai' && route.rates.transcriptionModel === undefined;
  const comparableCurrent = compatibleLegacyRoute
    ? {
        ...current,
        rates: Object.fromEntries(
          Object.keys(route.rates).map((key) => [
            key,
            current.rates[key as keyof typeof current.rates],
          ]),
        ),
      }
    : current;
  if (JSON.stringify(canonical(comparableCurrent)) !== JSON.stringify(canonical(route)))
    throw new VoiceModelUnavailableError(
      'The saved voice route changed after this call was placed. End it and place a new call.',
    );
  return resolved;
}
