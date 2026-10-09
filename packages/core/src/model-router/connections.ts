import { type Config, parseFirestoreEmbeddingSpace } from '@assistant/config';
import type { Records } from '@assistant/persistence';
import { decryptStoredCredential } from '../mcp-secrets.js';
import {
  createOpenAICompatibleModelProvider,
  createOpenAIModelProvider,
  createOpenRouterModelProvider,
  createVertexModelProvider,
  type ModelProvider,
} from './provider.js';

/**
 * Owner-connected model providers.
 *
 * Every model identity names the connection that serves it:
 *
 *   vertex:<model>         → the Vertex connection (ADC, no key)
 *   openai:<model>         → the OpenAI connection
 *   gw:<connection>:<model> → an OpenAI-compatible gateway the owner added
 *   anything else          → OpenRouter (every pre-existing model ID)
 *
 * So a role can use OpenAI for planning and OpenRouter for drafting, and the
 * choice lives in the model catalog the owner edits in the app rather than in
 * a deploy-time environment variable. Environment credentials remain the
 * bootstrap: until the owner saves a connection of a kind, the matching env
 * settings stand in for it, so an existing installation keeps working with no
 * migration.
 */

export const MODEL_CONNECTION_KINDS = [
  'openrouter',
  'openai',
  'vertex',
  'openai_compatible',
] as const;
export type ModelConnectionKind = (typeof MODEL_CONNECTION_KINDS)[number];

export type ModelConnectionRecord = Records['modelConnections'];

/** Custom gateway connection ids: short, URL- and model-ID-safe slugs. */
export const GATEWAY_CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The connection a model identity belongs to. Built-in kinds use their kind
 * as a fixed id (there is one OpenAI account, one OpenRouter account); custom
 * gateways use the owner-chosen slug embedded in the model ID.
 */
export function connectionIdForModel(modelId: string): string {
  if (/^vertex[:/]/i.test(modelId)) return 'vertex';
  if (modelId.startsWith('openai:')) return 'openai';
  const gateway = /^gw:([^:]+):/.exec(modelId);
  if (gateway?.[1]) return gateway[1];
  return 'openrouter';
}

/** Which router a request goes through. */
export interface ModelProviderSet {
  readonly kind: 'model-provider-set';
  /** Bring stored connections up to date (cheap when fresh). */
  refresh(): Promise<void>;
  /** The provider serving this model identity; throws when nothing can. */
  resolve(modelId: string): ModelProvider;
}

export function isModelProviderSet(value: unknown): value is ModelProviderSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'model-provider-set'
  );
}

/** A fixed single provider, for tests and callers that pin one explicitly. */
export function singleModelProviderSet(provider: ModelProvider): ModelProviderSet {
  return {
    kind: 'model-provider-set',
    refresh: async () => {},
    resolve: () => provider,
  };
}

type ProviderConfig = Pick<
  Config,
  'LLM_PROVIDER' | 'OPENROUTER_API_KEY' | 'VERTEX_PROJECT' | 'VERTEX_LOCATION'
> &
  Partial<Pick<Config, 'FIRESTORE_EMBEDDING_SPACE'>>;

function embeddingDimensions(config: ProviderConfig): number | undefined {
  const space = config.FIRESTORE_EMBEDDING_SPACE?.trim()
    ? parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE)
    : undefined;
  return space?.provider === 'vertex' ? space.dimensions : undefined;
}

/** Build the adapter a stored connection describes. Secrets are opened here, and only here. */
export function providerForConnection(
  connection: ModelConnectionRecord,
  config: ProviderConfig,
  decrypt: (payload: string) => string = decryptStoredCredential,
): ModelProvider {
  const key = connection.apiKeyEncrypted ? decrypt(connection.apiKeyEncrypted) : '';
  switch (connection.kind as ModelConnectionKind) {
    case 'openrouter': {
      // A saved row without its own key (the owner only renamed or toggled the
      // environment's connection) keeps using the deployment's key.
      const apiKey = key || config.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error('The OpenRouter connection has no API key');
      return createOpenRouterModelProvider(apiKey);
    }
    case 'openai':
      return createOpenAIModelProvider(key);
    case 'vertex':
      return createVertexModelProvider({
        project: connection.vertexProject || config.VERTEX_PROJECT,
        location: connection.vertexLocation || config.VERTEX_LOCATION,
        embeddingDimensions: embeddingDimensions(config),
      });
    case 'openai_compatible':
      return createOpenAICompatibleModelProvider({
        connectionId: connection.id,
        baseUrl: connection.baseUrl ?? '',
        apiKey: key || undefined,
      });
    default:
      throw new Error(`Unknown model connection kind: ${connection.kind}`);
  }
}

/**
 * The environment's stand-in for a built-in connection the owner has not
 * saved. An installation configured for Vertex (LLM_PROVIDER=vertex) gets no
 * implicit OpenRouter connection, preserving its no-OpenRouter guarantee even
 * if a stray key is present.
 */
function environmentProvider(connectionId: string, config: ProviderConfig): ModelProvider | null {
  if (connectionId === 'openrouter' && config.LLM_PROVIDER !== 'vertex') {
    return config.OPENROUTER_API_KEY
      ? createOpenRouterModelProvider(config.OPENROUTER_API_KEY)
      : null;
  }
  if (connectionId === 'vertex' && config.VERTEX_PROJECT && config.VERTEX_LOCATION) {
    return createVertexModelProvider({
      project: config.VERTEX_PROJECT,
      location: config.VERTEX_LOCATION,
      embeddingDimensions: embeddingDimensions(config),
    });
  }
  return null;
}

export interface ConnectedModelProviderOptions {
  /** How long a loaded connection list is trusted before re-reading it. */
  ttlMs?: number;
  now?: () => number;
  decrypt?: (payload: string) => string;
}

/**
 * Providers built from the owner's stored connections, falling back to the
 * environment. The list is re-read at most once per `ttlMs`, so a key saved in
 * Settings reaches the agent within seconds, without a redeploy. A failed
 * re-read cannot extend the authority of the last policy snapshot; cold or
 * expired snapshots fail closed until storage recovers.
 */
export function createConnectedModelProviders(
  config: ProviderConfig,
  loadConnections: () => Promise<ModelConnectionRecord[]>,
  options: ConnectedModelProviderOptions = {},
): ModelProviderSet {
  const configuredTtl = options.ttlMs ?? 30_000;
  const ttlMs = Number.isFinite(configuredTtl)
    ? Math.max(1, Math.min(30_000, configuredTtl))
    : 30_000;
  const now = options.now ?? Date.now;
  let connections = new Map<string, ModelConnectionRecord>();
  let loadedAt: number | undefined;
  let inflight: Promise<void> | undefined;
  let retryAfter = 0;
  const fresh = () =>
    loadedAt !== undefined &&
    Number.isFinite(now()) &&
    now() >= loadedAt &&
    now() - loadedAt < ttlMs;
  // Adapters are cheap but not free (Vertex resolves ADC lazily per instance);
  // reuse one per connection version.
  const built = new Map<string, { version: string; provider: ModelProvider }>();
  const fromEnv = new Map<string, ModelProvider | null>();

  const load = async () => {
    try {
      const rows = await loadConnections();
      connections = new Map(rows.map((row) => [row.id, row]));
      const loadedTime = now();
      if (!Number.isFinite(loadedTime)) throw new Error('Invalid connection policy clock');
      loadedAt = loadedTime;
      retryAfter = 0;
    } catch {
      retryAfter = now() + Math.min(ttlMs, 5_000);
      throw new Error('Model connection policy is unavailable; provider calls are paused');
    }
  };

  return {
    kind: 'model-provider-set',
    async refresh() {
      if (fresh()) return;
      if (now() < retryAfter)
        throw new Error('Model connection policy is unavailable; provider calls are paused');
      inflight ??= load().finally(() => {
        inflight = undefined;
      });
      await inflight;
    },
    resolve(modelId) {
      if (!fresh())
        throw new Error(
          'Model connection policy is unavailable or expired; refresh before provider calls',
        );
      const connectionId = connectionIdForModel(modelId);
      const stored = connections.get(connectionId);
      let provider: ModelProvider | null;
      if (stored) {
        if (!stored.enabled) {
          throw new Error(`Model connection "${stored.label}" is turned off (model ${modelId})`);
        }
        const version = `${stored.updatedAt.getTime()}`;
        const cached = built.get(stored.id);
        if (cached?.version === version) {
          provider = cached.provider;
        } else {
          provider = providerForConnection(stored, config, options.decrypt);
          built.set(stored.id, { version, provider });
        }
      } else {
        if (!fromEnv.has(connectionId))
          fromEnv.set(connectionId, environmentProvider(connectionId, config));
        provider = fromEnv.get(connectionId) ?? null;
      }
      if (!provider) {
        throw new Error(
          `No model connection serves ${modelId}; connect it in Settings → AI providers`,
        );
      }
      provider.assertModelId(modelId);
      return provider;
    },
  };
}
