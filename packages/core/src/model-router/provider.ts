import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type Config, parseFirestoreEmbeddingSpace } from '@assistant/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { EmbeddingModel, JSONValue, LanguageModel } from 'ai';

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export type ModelProviderKind = 'openrouter' | 'vertex' | 'openai' | 'openai_compatible';

/**
 * What this particular call wants from a model's hidden reasoning.
 *
 * Three states, not two, because "do not reason" and "cannot reason" must send
 * different requests. A model with optional reasoning can be told explicitly to
 * stay quiet — omitting the parameter leaves the provider's own default in
 * charge, which for these models is to reason freely and bill for it. A model
 * with no reasoning capability must be sent nothing at all: `chat()` sets
 * OpenRouter's `require_parameters`, so naming a parameter the upstream pool
 * does not implement narrows that pool and can empty it outright.
 */
export type ReasoningMode = 'enabled' | 'disabled' | 'unsupported';

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported USD, when authoritative usage includes it. */
  costUsd?: number;
  generationId?: string;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  /** Reject model IDs belonging to another provider before constructing a request. */
  assertModelId(modelId: string): void;
  /**
   * `interactive` marks a call somebody is waiting on, so a provider that can
   * choose between upstreams can prefer a fast one.
   */
  chat(modelId: string, options?: { interactive?: boolean }): LanguageModel;
  textEmbeddingModel(modelId: string): EmbeddingModel;
  /** Only true when this model is verified to allow reasoning to be disabled. */
  canDisableReasoning?(modelId: string): boolean;
  optionsFor(input: { reasoning: ReasoningMode; modelId?: string }): ProviderOptions | undefined;
  /** Provider options applied to the embedding request. */
  embeddingOptions(): ProviderOptions | undefined;
  /** Provider-specific cache hints for the message boundary, if supported. */
  cacheHint(): Record<string, JSONValue> | undefined;
  normalizeUsage(event: unknown): ProviderUsage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerMetadataRecord(
  root: Record<string, unknown> | undefined,
  finalStep: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const metadata of [root, finalStep]) {
    for (const key of keys) {
      const value = record(metadata?.[key]);
      const usage = record(value?.usage);
      if (usage && Object.keys(usage).length > 0) return usage;
    }
  }
  return undefined;
}

function finiteNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Normalize OpenRouter's provider metadata without making absent cost look free. */
export function normalizeOpenRouterUsage(event: unknown): ProviderUsage {
  const root = record(event);
  const usage = record(root?.usage);
  const finalStep = record(root?.finalStep);
  const providerMetadata = providerMetadataRecord(
    record(root?.providerMetadata),
    record(finalStep?.providerMetadata),
    ['openrouter'],
  );
  const response = record(root?.response);
  return {
    inputTokens: finiteNonnegativeInteger(usage?.inputTokens),
    outputTokens: finiteNonnegativeInteger(usage?.outputTokens),
    costUsd: finiteNonnegative(providerMetadata?.cost),
    generationId: nonemptyString(response?.id),
  };
}

/** Vertex reports token usage through the common AI SDK result shape. */
export function normalizeVertexUsage(event: unknown): ProviderUsage {
  const root = record(event);
  const usage = record(root?.usage);
  const finalStep = record(root?.finalStep);
  const providerMetadata = providerMetadataRecord(
    record(root?.providerMetadata),
    record(finalStep?.providerMetadata),
    ['vertex', 'googleVertex', 'google-vertex'],
  );
  const response = record(root?.response);
  return {
    inputTokens: finiteNonnegativeInteger(usage?.inputTokens),
    outputTokens: finiteNonnegativeInteger(usage?.outputTokens),
    costUsd: finiteNonnegative(providerMetadata?.costUsd ?? providerMetadata?.cost),
    generationId: nonemptyString(response?.id),
  };
}

function assertOpenRouterModelId(modelId: string): void {
  // OpenRouter legitimately uses IDs such as google/gemini-* and openai/gpt-*.
  // The colon namespaces (vertex:, openai:, gw:) belong to the direct
  // adapters, so a model meant for one of them can never be sent here.
  if (
    !modelId ||
    /^(?:vertex(?:[/:]|$)|google:|openai:|gw:|projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/)/i.test(
      modelId,
    )
  ) {
    throw new Error(`OpenRouter provider cannot serve model identity: ${modelId || '<empty>'}`);
  }
}

// OpenRouter /api/v1/models reasoning.mandatory=false, checked 2026-09-19.
// Capability `thinking` alone does not imply an off switch. Keep unknown IDs
// (including new versions/variants) enabled until their behavior is verified.
const OPENROUTER_OPTIONAL_REASONING = new Set([
  'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v4-flash-0731',
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k3',
  // Catalog checked 2026-10-02: Luna supports `none`; Sol requires reasoning.
  'openai/gpt-6-luna',
]);

export interface OpenRouterModelProviderOptions {
  /** USD per million tokens. Used by isolated evaluations to bound upstream prices. */
  maxPrice?: { prompt: number; completion: number; request?: number };
}

export function createOpenRouterModelProvider(
  apiKey: string,
  options: OpenRouterModelProviderOptions = {},
): ModelProvider {
  if (
    options.maxPrice &&
    Object.values(options.maxPrice).some((price) => !Number.isFinite(price) || price < 0)
  ) {
    throw new Error('OpenRouter price ceilings must be finite nonnegative rates');
  }
  const provider = createOpenRouter({ apiKey });
  return {
    kind: 'openrouter',
    assertModelId: assertOpenRouterModelId,
    canDisableReasoning: (modelId) => OPENROUTER_OPTIONAL_REASONING.has(modelId),
    chat(modelId, callOptions) {
      assertOpenRouterModelId(modelId);
      return provider.chat(modelId, {
        provider: {
          // require_parameters: OpenRouter must only route to providers that
          // support everything this request sends.
          require_parameters: true,
          // One model is served by several upstreams of very different speed,
          // and the slow tail is real: successful calls have been observed at
          // 97-118s in prod. Ordering by latency costs nothing when they are
          // all healthy and avoids the tail when they are not. Only for calls
          // someone is waiting on — background work would rather have the
          // cheapest upstream than the quickest.
          ...(callOptions?.interactive ? { sort: 'latency' as const } : {}),
          ...(options.maxPrice ? { max_price: options.maxPrice } : {}),
        },
      });
    },
    textEmbeddingModel(modelId) {
      assertOpenRouterModelId(modelId);
      return provider.textEmbeddingModel(modelId);
    },
    optionsFor({ reasoning, modelId }) {
      if (reasoning === 'unsupported') return undefined;
      // GPT-6 accepts effort levels rather than a hard reasoning-token budget.
      // Keep the router's billed output headroom, but do not imply that its
      // 4096-token reasoning hint is an enforceable limit for these models.
      if (reasoning === 'enabled' && /^openai\/gpt-6(?:\.1-sol|-luna)$/.test(modelId ?? '')) {
        return { openrouter: { reasoning: { effort: 'medium' } } };
      }
      return reasoning === 'enabled'
        ? { openrouter: { reasoning: { max_tokens: 4_096 } } }
        : { openrouter: { reasoning: { enabled: false } } };
    },
    embeddingOptions: () => undefined,
    cacheHint: () => ({ openrouter: { cacheControl: { type: 'ephemeral' } } }),
    normalizeUsage: normalizeOpenRouterUsage,
  };
}

export interface VertexModelProviderOptions {
  /** Explicitly selected Google Cloud project used for ADC-backed requests. */
  project: string;
  /** Explicit Vertex region, for example `us-central1`. */
  location: string;
  /** Output width selected for this installation's embedding space. */
  embeddingDimensions?: number;
}

function vertexModelId(modelId: string): string {
  const match = /^vertex(?::|\/)(.+)$/i.exec(modelId);
  if (!match?.[1]) {
    throw new Error(
      `Vertex provider requires a vertex-qualified model identity: ${modelId || '<empty>'}`,
    );
  }
  const id = match[1];
  // Vertex model IDs are bare slugs. Requiring this shape prevents an
  // OpenRouter/provider namespace, URL, or resource path from being sent to
  // Vertex while leaving model availability to the configured project.
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(id)) {
    throw new Error(`Vertex provider requires a bare model identity: ${modelId}`);
  }
  return id;
}

function assertVertexModelId(modelId: string): void {
  vertexModelId(modelId);
}

/**
 * Vertex's gemini-embedding-001 predict endpoint accepts one text per request.
 * The SDK otherwise advertises a larger batch size for this model, so expose
 * the stricter limit to AI SDK's embedMany splitter while preserving the SDK instance.
 */
function singleInputVertexEmbeddingModel(model: EmbeddingModel): EmbeddingModel {
  if (typeof model === 'string')
    throw new Error('Vertex embedding provider returned an unresolved model ID');
  // This model is constructed solely for this adapter invocation. Override the
  // advertised batch limit on that instance so methods retain their original receiver.
  Object.defineProperty(model, 'maxEmbeddingsPerCall', { value: 1, configurable: false });
  return model;
}

/**
 * Construct the opt-in ADC-backed Vertex adapter. This does not make a
 * request during construction; the AI SDK obtains credentials only when a
 * model call is executed. No API-key/Express mode is configured here.
 */
export function createVertexModelProvider(options: VertexModelProviderOptions): ModelProvider {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) {
    throw new Error(`Vertex provider requires a valid Google Cloud project ID: ${options.project}`);
  }
  if (!/^(?:global|[a-z][a-z0-9-]*[0-9])$/.test(options.location)) {
    throw new Error(`Vertex provider requires a valid Vertex location: ${options.location}`);
  }
  if (
    options.embeddingDimensions !== undefined &&
    (!Number.isInteger(options.embeddingDimensions) ||
      options.embeddingDimensions < 1 ||
      options.embeddingDimensions > 2_048)
  ) {
    throw new Error('Vertex embedding dimensions must be an integer from 1 through 2048');
  }
  // An explicit empty string is intentional: the SDK otherwise falls back to
  // GOOGLE_VERTEX_API_KEY when present and silently selects Express mode.
  // Empty disables that fallback while leaving ADC/service identity active.
  const provider = createVertex({
    project: options.project,
    location: options.location,
    apiKey: '',
  });
  return {
    kind: 'vertex',
    assertModelId: assertVertexModelId,
    // Preserve the Vertex adapter's existing thinkingBudget=0 behavior.
    canDisableReasoning: () => true,
    chat(modelId) {
      return provider.languageModel(vertexModelId(modelId));
    },
    textEmbeddingModel(modelId) {
      const id = vertexModelId(modelId);
      const model = provider.embeddingModel(id);
      return id === 'gemini-embedding-001' ? singleInputVertexEmbeddingModel(model) : model;
    },
    optionsFor({ reasoning, modelId }) {
      if (reasoning === 'unsupported') return undefined;
      if (modelId && vertexModelId(modelId) === 'gemini-3.1-flash-lite') {
        // Gemini 3.1 uses levels. The legacy thinkingBudget field returns 400.
        return {
          vertex: {
            thinkingConfig: { thinkingLevel: reasoning === 'enabled' ? 'high' : 'minimal' },
          },
        };
      }
      return reasoning === 'enabled'
        ? { vertex: { thinkingConfig: { thinkingBudget: 4_096 } } }
        : { vertex: { thinkingConfig: { thinkingBudget: 0 } } };
    },
    embeddingOptions: () => ({
      vertex: { outputDimensionality: options.embeddingDimensions ?? 1_536 },
    }),
    cacheHint: () => undefined,
    normalizeUsage: normalizeVertexUsage,
  };
}

/** The bare model slug after an `openai:` namespace, e.g. `openai:gpt-5.1` → `gpt-5.1`. */
function openAIModelId(modelId: string): string {
  const match = /^openai:([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(modelId);
  if (!match?.[1]) {
    throw new Error(
      `OpenAI provider requires an openai:-qualified model identity: ${modelId || '<empty>'}`,
    );
  }
  return match[1];
}

/** Normalize the common AI SDK usage shape; OpenAI reports tokens, not cost. */
function normalizeCommonUsage(event: unknown): ProviderUsage {
  const root = record(event);
  const usage = record(root?.usage);
  const response = record(root?.response);
  return {
    inputTokens: finiteNonnegativeInteger(usage?.inputTokens),
    outputTokens: finiteNonnegativeInteger(usage?.outputTokens),
    generationId: nonemptyString(response?.id),
  };
}

/**
 * Direct OpenAI API (platform.openai.com key). Reasoning is left at the
 * model's own default: which OpenAI models accept an off switch varies by
 * family, and sending an unsupported effort level is a hard 400. Cost comes
 * from the configured per-model rates, since OpenAI reports tokens only.
 */
export function createOpenAIModelProvider(apiKey: string): ModelProvider {
  if (!apiKey) throw new Error('OpenAI provider requires an API key');
  const provider = createOpenAI({ apiKey });
  return {
    kind: 'openai',
    assertModelId: (modelId) => void openAIModelId(modelId),
    chat: (modelId) => provider.chat(openAIModelId(modelId)),
    textEmbeddingModel: (modelId) => provider.embeddingModel(openAIModelId(modelId)),
    optionsFor: () => undefined,
    embeddingOptions: () => ({ openai: { dimensions: 1_536 } }),
    // OpenAI caches long prompt prefixes automatically.
    cacheHint: () => undefined,
    normalizeUsage: normalizeCommonUsage,
  };
}

export interface OpenAICompatibleModelProviderOptions {
  /** The owner's connection id; model identities are `gw:<connectionId>:<model>`. */
  connectionId: string;
  baseUrl: string;
  apiKey?: string;
}

/** The upstream model name after a `gw:<connectionId>:` namespace. */
export function gatewayModelId(connectionId: string, modelId: string): string {
  const prefix = `gw:${connectionId}:`;
  const id = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : '';
  // Gateways use their own naming (`meta-llama/Llama-4`, `llama3.2:3b`), so
  // only reject what can never be a model name: empty or whitespace.
  if (!id || /\s/.test(id)) {
    throw new Error(`Gateway ${connectionId} cannot serve model identity: ${modelId || '<empty>'}`);
  }
  return id;
}

/**
 * Any OpenAI-compatible endpoint the owner connects: Groq, Together, a
 * LiteLLM proxy, a local Ollama. Structured outputs are not assumed; the SDK
 * falls back to JSON mode, which every compatible server accepts.
 */
export function createOpenAICompatibleModelProvider(
  options: OpenAICompatibleModelProviderOptions,
): ModelProvider {
  const url = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Gateway base URL must be HTTP(S) without embedded credentials');
  }
  const provider = createOpenAICompatible({
    name: options.connectionId,
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    includeUsage: true,
  });
  return {
    kind: 'openai_compatible',
    assertModelId: (modelId) => void gatewayModelId(options.connectionId, modelId),
    chat: (modelId) => provider.chatModel(gatewayModelId(options.connectionId, modelId)),
    textEmbeddingModel: (modelId) =>
      provider.embeddingModel(gatewayModelId(options.connectionId, modelId)),
    optionsFor: () => undefined,
    embeddingOptions: () => undefined,
    cacheHint: () => undefined,
    normalizeUsage: normalizeCommonUsage,
  };
}

/** Explicit application composition; preserves OpenRouter unless the owner selects Vertex. */
export function createConfiguredModelProvider(
  config: Pick<
    Config,
    'LLM_PROVIDER' | 'OPENROUTER_API_KEY' | 'VERTEX_PROJECT' | 'VERTEX_LOCATION'
  > &
    Partial<Pick<Config, 'FIRESTORE_EMBEDDING_SPACE'>>,
): ModelProvider {
  if (config.LLM_PROVIDER !== 'vertex')
    return createOpenRouterModelProvider(config.OPENROUTER_API_KEY);
  const space = config.FIRESTORE_EMBEDDING_SPACE?.trim()
    ? parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE)
    : undefined;
  if (space && space.provider !== 'vertex') {
    throw new Error('Vertex provider requires a Vertex Firestore embedding space');
  }
  return createVertexModelProvider({
    project: config.VERTEX_PROJECT,
    location: config.VERTEX_LOCATION,
    embeddingDimensions: space?.dimensions,
  });
}
