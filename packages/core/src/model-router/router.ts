import { createHash } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { createPostgresModelRoutingRepository, type Db } from '@assistant/db';
import {
  type CostBasis,
  type EmbeddingSpace,
  embeddingModelId,
  embeddingSpaceIdentityKey,
  type ModelRoutingRepository,
  POSTGRES_EMBEDDING_DIMENSIONS,
  validateEmbeddingSpace,
} from '@assistant/persistence';
import {
  type EmbeddingModel,
  embedMany,
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
import { type ZodType, z } from 'zod';
import {
  BudgetReservationError,
  beginCostAttempt,
  costTotals,
  markCostAttemptUnknown,
  reconcileReservation,
  releaseReservation,
  reserveCost,
} from '../cost.js';
import { withSpan } from '../otel.js';
import { type AuditCaptureMode, captureField, captureInput } from './audit-capture.js';
import {
  explicitlyRequestsRepetition,
  gradeAuditedOutput,
  OBJECT_PARSE_FAILURE_PREFIX,
} from './audit-graders.js';
import { type BudgetDecision, evaluateBudget } from './budget.js';
import {
  connectionIdForModel,
  isModelProviderSet,
  type ModelProviderSet,
  singleModelProviderSet,
} from './connections.js';
import {
  createOpenRouterModelProvider,
  isProviderApiError,
  isProviderAuthDenial,
  isProviderTransientError,
  type ModelProvider,
  normalizeVertexUsage,
  type ProviderOptions,
  type ProviderRequestProfile,
  type ProviderUsage,
  providerErrorNodes,
  providerStatusCode,
  type ReasoningMode,
} from './provider.js';
import { modelCallRuntimeIdentity } from './runtime-identity.js';

export type ModelRole =
  | 'plan'
  | 'classify'
  | 'extract'
  | 'draft'
  | 'reason'
  | 'rewrite'
  | 'embed'
  | 'batch';

export interface RouteOptions {
  taskId?: string;
  /** Explicit model pick (chat switcher). Must exist + be enabled; still budget-guarded. */
  modelOverride?: string;
  /** Use this role's configured fallback model even when the budget is healthy. */
  forceFallback?: boolean;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
  /**
   * The caller already resolved this conversation's model override, so an
   * absent `modelOverride` means "none", not "not looked up yet". Without it
   * `route()` re-reads an override the caller is holding — the chat turn has
   * the conversation row in hand and passes its column straight through.
   */
  modelOverrideResolved?: boolean;
  requestProfile?: Omit<ProviderRequestProfile, 'reasoning' | 'maxPrice' | 'privacy'>;
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  maxOutputTokens?: number;
  additionalInputTokens?: number;
  maxEstimatedCostUsd?: number;
}

export type Route =
  | {
      ok: true;
      model: LanguageModel;
      modelId: string;
      degraded: boolean;
      /**
       * The model *can* reason (capability flag on its row). Whether a given
       * call can disable it also depends on the provider's model contract.
       */
      thinking: boolean;
      decision: BudgetDecision;
      params: Record<string, unknown>;
      promptCostPerMTok: number;
      completionCostPerMTok: number;
      requestProfile?: ProviderRequestProfile;
    }
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> };

export interface CallOptions {
  taskId?: string;
  modelOverride?: string;
  /** Use this role's configured fallback model even when the budget is healthy. */
  forceFallback?: boolean;
  /** Self-repair may opt into one router-owned fallback for transient pre-dispatch failures. */
  fallbackOnTransientProviderError?: boolean;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
  /** See RouteOptions.modelOverrideResolved. */
  modelOverrideResolved?: boolean;
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Reject before reservation/provider work if the estimated call cost exceeds this caller cap. */
  maxEstimatedCostUsd?: number;
  /** Extra input tokens for tool/schema overhead absent from prompt text. */
  additionalInputTokens?: number;
  /** AI SDK transport retries. Evaluations use zero; normal calls retain SDK defaults. */
  maxRetries?: number;
  /** Prevent router-owned timeout, capability, and output-quality retries for one-shot callers. */
  singleAttempt?: boolean;
  /** Exact features that must survive model routing and provider serialization. */
  requestProfile?: Omit<ProviderRequestProfile, 'reasoning' | 'maxPrice' | 'privacy'>;
}

/** Keep optional per-call cost ceilings inside the reservation path. */
export function assertEstimatedCostWithinLimit(
  estimatedUsd: number,
  maxEstimatedCostUsd: number | undefined,
): void {
  if (
    maxEstimatedCostUsd !== undefined &&
    (!Number.isFinite(maxEstimatedCostUsd) ||
      maxEstimatedCostUsd <= 0 ||
      estimatedUsd > maxEstimatedCostUsd)
  ) {
    throw new Error('estimated model call cost exceeds caller limit');
  }
}

/** The small tool-choice surface the workflow needs from the AI SDK. */
export type StepToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };

function requiredProviderParameters(profile: ProviderRequestProfile): string[] {
  const required: string[] = [];
  if (profile.tools !== 'none') required.push('tools');
  if (profile.toolChoice !== undefined && profile.toolChoice !== 'auto')
    required.push('tool_choice');
  if (profile.output === 'json_schema') required.push('structured_outputs');
  else if (profile.output === 'json') required.push('json_object');
  if (profile.reasoning !== 'unsupported') required.push('reasoning');
  return required;
}

function supportsFreshRequestProfile(
  capabilities: unknown,
  profile: ProviderRequestProfile,
): boolean {
  const row =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>)
      : {};
  const parameters = Array.isArray(row.supportedParameters)
    ? row.supportedParameters.filter(
        (parameter): parameter is string => typeof parameter === 'string',
      )
    : undefined;
  const checkedAt = typeof row.checkedAt === 'string' ? Date.parse(row.checkedAt) : NaN;
  const ageMs = Date.now() - checkedAt;
  if (!parameters || !Number.isFinite(checkedAt) || ageMs < 0 || ageMs > 30 * 24 * 60 * 60 * 1_000)
    return true;
  return requiredProviderParameters(profile).every((parameter) => parameters.includes(parameter));
}

function textRequestProfile(streaming: boolean): CallOptions['requestProfile'] {
  return { tools: 'none', output: 'text', streaming };
}

/**
 * Providers that enforce OpenAI's function-name pattern (^[a-zA-Z0-9_-]{1,128}$)
 * reject this project's dotted tool names outright — the request fails before
 * the model ever sees the tools, which looks identical to a model that simply
 * declined to call anything. Swap dots for underscores on the wire and undo it
 * on the way back, so only the provider sees the encoded form.
 */
export function encodeToolNames(tools: ToolSet): {
  encoded: ToolSet;
  decode: (name: string) => string;
} {
  const canonical = new Map<string, string>();
  const encoded: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const wireName = name.replace(/\./g, '_');
    const collision = canonical.get(wireName);
    if (collision && collision !== name) {
      throw new Error(`tool names "${collision}" and "${name}" both encode to "${wireName}"`);
    }
    canonical.set(wireName, name);
    encoded[wireName] = definition;
  }
  return { encoded, decode: (name) => canonical.get(name) ?? name };
}

/**
 * The checkpointed context window records canonical tool names in its
 * tool-call/tool-result parts. Those names are replayed to the provider on
 * every later step, so they need the same wire encoding as the tool defs —
 * otherwise a task calls a tool successfully on step 0 and then fails on
 * step 1 when its own history is rejected.
 */
function encodeMessageToolNames(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part && typeof part === 'object' && 'toolName' in part && typeof part.toolName === 'string'
          ? { ...part, toolName: part.toolName.replace(/\./g, '_') }
          : part,
      ),
    } as ModelMessage;
  });
}

export type GenerateOutcome =
  | {
      ok: false;
      decision: Extract<BudgetDecision, { mode: 'park' | 'block' }>;
      attempts?: ProviderAttemptEvidence[];
    }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: string;
      finishReason?: string;
      attempts?: ProviderAttemptEvidence[];
    };

export interface ProviderAttemptEvidence {
  method: 'generate' | 'step' | 'object' | 'stream';
  role: ModelRole;
  selection: 'primary' | 'fallback';
  modelId: string;
  requestProfile?: ProviderRequestProfile;
  elapsedMs: number;
  outcome: 'started' | 'succeeded' | 'failed';
  failureKind?:
    | 'timeout'
    | 'aborted'
    | 'provider_capability'
    | 'transient_provider'
    | 'authentication'
    | 'structured_output'
    | 'provider_rejected';
  /** True when this attempt was followed by a configured fallback attempt. */
  fallbackAttempted: boolean;
}

const attemptEvidenceByError = new WeakMap<object, ProviderAttemptEvidence[]>();

export function getProviderAttemptEvidence(error: unknown): ProviderAttemptEvidence[] {
  return error !== null && typeof error === 'object'
    ? (attemptEvidenceByError.get(error) ?? [])
    : [];
}

function attachProviderAttemptEvidence(error: unknown, attempts: ProviderAttemptEvidence[]): void {
  if (error !== null && typeof error === 'object') attemptEvidenceByError.set(error, attempts);
}

function withAttemptEvidence<T extends object>(outcome: T, previous: ProviderAttemptEvidence[]): T {
  const current =
    'attempts' in outcome && Array.isArray(outcome.attempts)
      ? (outcome.attempts as ProviderAttemptEvidence[])
      : [];
  const combined = [...previous, ...current];
  const fallbackWasAttempted = combined.some((attempt) => attempt.selection === 'fallback');
  return {
    ...outcome,
    attempts: combined.map((attempt) => ({
      ...attempt,
      fallbackAttempted:
        attempt.fallbackAttempted || (fallbackWasAttempted && attempt.selection === 'primary'),
    })),
  };
}

function providerFailureKind(error: unknown): ProviderAttemptEvidence['failureKind'] {
  if (isModelCallTimeout(error)) return 'timeout';
  if (isProviderAuthDenial(error)) return 'authentication';
  if (isUnparseableObjectError(error)) return 'structured_output';
  if (isProviderCapabilityError(error)) return 'provider_capability';
  if (isProviderTransientError(error)) return 'transient_provider';
  return 'provider_rejected';
}

/** A proposed (unexecuted) tool call — the executor feeds these to the risk gate. */
export interface ProposedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type StepCallOutcome =
  | {
      ok: false;
      decision: Extract<BudgetDecision, { mode: 'park' | 'block' }>;
      attempts?: ProviderAttemptEvidence[];
    }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: string;
      toolCalls: ProposedToolCall[];
      finishReason?: string;
      /** A repeated-generation guard exhausted its single fallback attempt. */
      qualityFailure?: true;
      attempts?: ProviderAttemptEvidence[];
    };

export type ObjectOutcome<T> =
  | {
      ok: false;
      decision: Extract<BudgetDecision, { mode: 'park' | 'block' }>;
      attempts?: ProviderAttemptEvidence[];
    }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      object: T;
      finishReason?: string;
      attempts?: ProviderAttemptEvidence[];
    };

/**
 * A structured-output call whose response was cut off at the token limit
 * (finishReason 'length') even after a fallback retry. The object still parses
 * (a truncated string is schema-valid), so without this the caller would accept
 * a half-formed value — the source of the truncated "Are you" clarify question.
 */
export class TruncatedObjectError extends Error {
  constructor(role: string) {
    super(`structured output for role '${role}' was truncated at the token limit`);
    this.name = 'TruncatedObjectError';
  }
}

export type StreamOutcome =
  | {
      ok: false;
      decision: Extract<BudgetDecision, { mode: 'park' | 'block' }>;
      attempts?: ProviderAttemptEvidence[];
    }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      /** Mutable terminal receipt updated when the stream finishes, fails, or aborts. */
      attempts: ProviderAttemptEvidence[];
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
      // Raw part stream for callers that compose their own UI message stream
      // (e.g. to append a post-draft part) instead of taking a Response. The
      // SDK's AsyncIterableStream surfaces as both shapes.
      toUIMessageStream: (
        options?: Record<string, unknown>,
      ) => ReadableStream<unknown> & AsyncIterable<unknown>;
    };

/** Loose supertype of the AI SDK finish events — only what metering reads. */
interface FinishEventLike {
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response?: { id?: string };
  responses?: unknown[];
  finishReason?: string;
}

interface EmbeddingProviderEvidence {
  usage?: { tokens?: number };
  providerMetadata?: Record<string, unknown>;
}

function observeEmbeddingModel(
  model: EmbeddingModel,
  evidence: EmbeddingProviderEvidence[],
): {
  model: EmbeddingModel;
  stop: () => void;
  waitForSettled: () => Promise<void>;
} {
  if (typeof model !== 'object' || model === null || !('doEmbed' in model)) {
    return { model, stop: () => {}, waitForSettled: async () => {} };
  }
  const candidate = model as {
    doEmbed?: (options: unknown) => PromiseLike<EmbeddingProviderEvidence>;
  };
  const doEmbed = candidate.doEmbed;
  if (typeof doEmbed !== 'function') {
    return { model, stop: () => {}, waitForSettled: async () => {} };
  }
  let stopped = false;
  const inFlight = new Set<Promise<EmbeddingProviderEvidence>>();
  let observedDoEmbed: ((options: unknown) => Promise<EmbeddingProviderEvidence>) | undefined;
  const observed = new Proxy(model as object, {
    get(target, property) {
      if (property === 'doEmbed') return observedDoEmbed;
      return Reflect.get(target, property, target);
    },
  }) as typeof candidate;
  observedDoEmbed = async (options) => {
    if (stopped) throw new Error('embedding batch stopped after provider failure');
    const operation = (async () => {
      const result = await doEmbed.call(model, options);
      evidence.push(result);
      return result;
    })();
    inFlight.add(operation);
    operation.then(
      () => inFlight.delete(operation),
      () => {
        stopped = true;
        inFlight.delete(operation);
      },
    );
    return operation;
  };
  return {
    model: observed as EmbeddingModel,
    stop: () => {
      stopped = true;
    },
    waitForSettled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function validTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
  );
}

function providerResultFromError(error: unknown): FinishEventLike | undefined {
  if (!isUnparseableObjectError(error) || !(error instanceof Error)) return undefined;
  const candidate = error as Error & FinishEventLike & { text?: unknown };
  if (!candidate.usage && !candidate.providerMetadata && !candidate.response && !candidate.text)
    return undefined;
  return candidate;
}

export function objectFailureAuditOutput(error: unknown): string | undefined {
  if (!isUnparseableObjectError(error) || !(error instanceof Error)) return undefined;
  const text = (error as Error & { text?: unknown }).text;
  return `${OBJECT_PARSE_FAILURE_PREFIX} (${error.name})\n${typeof text === 'string' ? text : ''}`;
}

const MALFORMED_OUTPUT_FALLBACK =
  "I couldn't produce a reliable answer just now. Please try again.";

function ownerRequestText(opts: CallOptions): string | undefined {
  if (opts.prompt) return opts.prompt;
  const message = opts.messages?.findLast((item) => item.role === 'user');
  if (!message) return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter(
      (part): part is Extract<(typeof message.content)[number], { type: 'text' }> =>
        Boolean(part) && typeof part === 'object' && 'type' in part && part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n');
}

function hasOutputIntegrityDefect(text: string, repetitionRequested: boolean): boolean {
  return gradeAuditedOutput(text, { repetitionRequested }).some(
    (defect) => defect.kind === 'repetitive-output' || defect.kind === 'malformed-output',
  );
}

function aggregateEmbeddingUsage(
  provider: ModelProvider,
  evidence: EmbeddingProviderEvidence[],
): ProviderUsage | undefined {
  if (evidence.length === 0) return undefined;
  let inputTokens = 0;
  let tokensKnown = true;
  let costUsd = 0;
  let costKnown = true;
  for (const result of evidence) {
    const usage = provider.normalizeUsage({
      usage: result.usage ? { inputTokens: result.usage.tokens, outputTokens: 0 } : undefined,
      providerMetadata: result.providerMetadata,
    });
    if (validTokenCount(usage.inputTokens)) {
      inputTokens += usage.inputTokens;
    } else {
      tokensKnown = false;
    }
    if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
      costUsd += usage.costUsd;
    } else {
      costKnown = false;
    }
  }
  const aggregateTokens = tokensKnown && validTokenCount(inputTokens) ? inputTokens : undefined;
  return {
    inputTokens: aggregateTokens,
    outputTokens: aggregateTokens === undefined ? undefined : 0,
    costUsd: costKnown && Number.isFinite(costUsd) ? costUsd : undefined,
  };
}

interface MeterInput {
  taskId?: string;
  role: string;
  modelId: string;
  latencyMs: number;
  event: FinishEventLike;
  reservationId: string;
  estimatedUsd: number;
  usageOverride?: ProviderUsage;
  promptCostPerMTok: number;
  completionCostPerMTok: number;
  requestProfile?: ProviderRequestProfile;
  /**
   * What to keep for quality review, when capture is enabled. Absent on the
   * embed path: an embedding has no answer to judge.
   */
  audit?: AuditPayload;
}

/** The reviewable half of a call: what it was asked, and what it said back. */
interface AuditPayload {
  method: 'generate' | 'stream' | 'step' | 'object';
  system?: string;
  input?: string;
  output?: string;
}

/** Structured output as reviewable text, never at the cost of the audit write. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** A step's prose plus the calls it chose, so a tool-calling turn reads as one. */
function stepOutputForAudit(
  text: string,
  toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>,
): string | undefined {
  const calls = toolCalls.map((tc) => `→ ${tc.toolName}(${safeJson(tc.input) ?? ''})`);
  const parts = [text.trim(), ...calls].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

const DEFAULT_MAX_OUTPUT_TOKENS: Record<Exclude<ModelRole, 'embed'>, number> = {
  plan: 1_024,
  classify: 512,
  extract: 1_024,
  draft: 2_048,
  reason: 4_096,
  rewrite: 2_048,
  batch: 4_096,
};
const HARD_MAX_OUTPUT_TOKENS = 4_096;
const ESTIMATE_SAFETY_FACTOR = 1.25;
export const EMBEDDING_DIMENSIONS = 1_536;

function catalogRevision(value: Date | undefined): string {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : 'unversioned-catalog';
}
// OpenRouter load-balances each request across upstream providers, and the
// slow tail is real: successful deepseek-chat calls on goal-session prompts
// have been observed at 97–118s in prod. 120s cut those off mid-generation
// (billed but discarded); 150s clears the observed tail while staying far
// inside the executor's 900s request window and 10-min heartbeated lease.
const MODEL_CALL_TIMEOUT_MS = 150_000;

/**
 * Shorter deadlines for the calls a person is sitting and waiting on.
 *
 * The 150s above was measured against goal-session *step* prompts — long,
 * tool-carrying, running behind a queue where nobody is watching a cursor
 * blink. A streamed reply and the triage classifier in front of it are the
 * opposite: they sit in the request path of a chat turn, so spending 150s on
 * one before even reporting failure is far worse than failing early and
 * retrying. Tool-calling steps keep the full budget (see `modelCallSignal`),
 * so the tuning the original number came from is untouched.
 */
const INTERACTIVE_CALL_TIMEOUT_MS: Partial<Record<ModelRole, number>> = {
  classify: 30_000,
  draft: 60_000,
};

/**
 * Roles that answer a person who is waiting, rather than a queue.
 *
 * Used for two things: the shorter deadlines above, and asking the provider to
 * prefer a fast upstream when it has the choice.
 */
export function isInteractiveRole(role: ModelRole): boolean {
  return INTERACTIVE_CALL_TIMEOUT_MS[role] !== undefined;
}

/**
 * Roles whose answers are worth hidden reasoning even with no tools in play.
 *
 * Reasoning tokens are generated *before* the visible answer, so on any call a
 * person is waiting for they are pure added latency (and billed output). Only
 * the two roles whose whole job is deliberation request it by default; a
 * tool-calling step keeps it regardless of role, because a step that cannot
 * think may fail to emit the tool call at all. Models that require reasoning
 * keep it for every role.
 */
const REASONING_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>(['plan', 'reason']);

/*
 * `model_roles` and `models` are read on every call and look like obvious
 * cache candidates — they are tiny and change rarely. They are deliberately
 * NOT cached. Routing config is also a safety control: `route()` refuses a
 * disabled model so a retired provider is never billed, and the owner's model
 * choice is expected to take effect on the next message. A TTL turns both into
 * "eventually", and the router runs in more than one process, so no in-process
 * invalidation can cover a change made elsewhere. Two indexed lookups on a
 * pooled connection are not worth paying for with a window where a disabled
 * model still routes.
 */

/**
 * Reasoning ("thinking") models spend completion tokens on hidden reasoning
 * before the visible answer, and that reasoning is billed against the same
 * `max_tokens` budget. If reasoning shares the visible-output budget it starves
 * — or entirely preempts — the answer: the model stops at finishReason 'length'
 * with truncated or empty text (the "request failed after thinking" chat
 * turns, plus triage/classify JSON that never lands). Give reasoning its own
 * bounded headroom on top of the visible budget, and cap it via OpenRouter so
 * the answer always keeps its full allocation. Only a call that will actually
 * reason gets this — see `reasoningMode`, which is narrower than the model's
 * capability flag: a classifier on a model with verified optional reasoning
 * can skip it and needs no headroom to protect.
 */
const REASONING_HEADROOM_TOKENS = 4_096;

/**
 * Exported for test: `AbortSignal.timeout` is native and does not move under
 * fake timers, so the deadline is verified as the number it is chosen to be.
 */
export function modelCallTimeoutMs(role: ModelRole | undefined, toolCall: boolean): number {
  if (toolCall || !role) return MODEL_CALL_TIMEOUT_MS;
  return INTERACTIVE_CALL_TIMEOUT_MS[role] ?? MODEL_CALL_TIMEOUT_MS;
}

function modelCallSignal(
  signal: AbortSignal | undefined,
  role?: ModelRole,
  toolCall = false,
): AbortSignal {
  const deadline = AbortSignal.timeout(modelCallTimeoutMs(role, toolCall));
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function promptArgs(opts: CallOptions): { messages: ModelMessage[] } | { prompt: string } {
  if (opts.messages) return { messages: opts.messages };
  if (opts.prompt !== undefined) return { prompt: opts.prompt };
  throw new Error('model call needs messages or prompt');
}

function estimatedInputTokens(opts: CallOptions): number {
  const additional = opts.additionalInputTokens ?? 0;
  if (!Number.isSafeInteger(additional) || additional < 0 || additional > 1_000_000) {
    throw new Error('additionalInputTokens must be an integer from zero to one million');
  }
  if (
    opts.maxRetries !== undefined &&
    (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0 || opts.maxRetries > 2)
  ) {
    throw new Error('maxRetries must be an integer from zero to two');
  }
  const content = opts.messages ? JSON.stringify(opts.messages) : (opts.prompt ?? '');
  // ~3.5 chars/token holds for English prose and JSON tool payloads. The old
  // /2 estimate was ~2x pessimistic, which inflated every reservation and
  // tripped the soft budget threshold on spend that never materialized.
  return Math.max(1, Math.ceil(((opts.system?.length ?? 0) + content.length) / 3.5)) + additional;
}

function estimatedSerializedTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('Unable to estimate serialized model input');
  return Math.ceil(serialized.length / 3.5);
}

function schemaInputTokens(schema: ZodType): number {
  return estimatedSerializedTokens(z.toJSONSchema(schema));
}

function toolInputTokens(tools: ToolSet): number {
  const requestSchema = Object.entries(tools).map(([name, raw]) => {
    const tool = raw as unknown as {
      description?: string;
      inputSchema?: ZodType;
      parameters?: ZodType;
    };
    const schema = tool.inputSchema ?? tool.parameters;
    if (!schema) throw new Error(`Tool ${name} does not expose a countable input schema`);
    return { name, description: tool.description ?? '', parameters: z.toJSONSchema(schema) };
  });
  return estimatedSerializedTokens(requestSchema);
}

function withAdditionalInputTokens<T extends CallOptions>(opts: T, additional: number): T {
  const value = (opts.additionalInputTokens ?? 0) + additional;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error('Prepared schema/tool overhead exceeds the supported token estimate');
  }
  return { ...opts, additionalInputTokens: value };
}

function reservationDecision(reason: string): Extract<BudgetDecision, { mode: 'park' | 'block' }> {
  return { mode: reason.startsWith('task budget') ? 'park' : 'block', reason };
}

/**
 * True when generateObject failed because the model's response could not be
 * parsed into the schema (the AI SDK's AI_NoObjectGeneratedError) — a *quality*
 * failure of a weak model, not a transient/provider one. Detected by name so it
 * does not depend on the SDK re-exporting the error class. Callers use this to
 * retry on a stronger model and, failing that, skip the single item rather than
 * fail (and eventually dead-letter) an entire durable job.
 */
export function isUnparseableObjectError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AI_NoObjectGeneratedError' || err.name === 'NoObjectGeneratedError')
  );
}

/**
 * The per-call deadline (modelCallSignal) aborts with a DOMException named
 * TimeoutError. Only that deadline produces this name inside a model call, so
 * it is safe to treat as "this one provider request was too slow" rather than
 * "the caller cancelled us".
 */
function isModelCallTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * True when a provider cannot serve this model/request rather than
 * failing transiently — e.g. a retired model returns HTTP 410, Novita serving deepseek-chat answers
 * "response format json_schema is not supported", and OpenRouter itself
 * reports an empty provider pool when routing preferences exclude everyone.
 * These never heal by retrying the same model: the cure is the role's
 * fallback model, whose provider pool is different. Kept deliberately
 * narrow so genuinely transient APICallErrors (429/5xx) stay with the
 * task-level retry.
 */
export function isProviderCapabilityError(err: unknown): boolean {
  const nodes = providerErrorNodes(err);
  // Authentication/configuration failures must never be hidden by a nested
  // incidental capability message from another attempted provider.
  if (isProviderAuthDenial(err)) return false;
  return nodes.some(({ value }) => {
    if (!isProviderApiError(value)) return false;
    const status = providerStatusCode(value.statusCode ?? value.status);
    const message = typeof value.message === 'string' ? value.message : '';
    return (
      status === 402 ||
      status === 410 ||
      /\bpayment method is required\b/i.test(message) ||
      /not supported|no endpoints? (found|match)|no allowed providers/i.test(message)
    );
  });
}

export class ModelFallbackAttemptError extends Error {
  readonly fallbackAttempted = true;
  readonly errors: unknown[];
  readonly cause: unknown;
  readonly attemptEvidence: {
    role: ModelRole;
    primaryModelId: string;
    fallbackModelId: string;
    primaryElapsedMs: number;
    elapsedMs: number;
    failureKind: 'structured_output' | 'provider_capability' | 'transient_provider';
    fallbackFailureKind:
      | 'structured_output'
      | 'provider_capability'
      | 'transient_provider'
      | 'authentication'
      | 'provider_rejected';
    requestProfile: {
      method: 'object';
      role: ModelRole;
      schema: true;
      maxOutputTokens?: number;
      maxRetries?: number;
    };
    primaryFailure: unknown;
    fallbackFailure: unknown;
    attempts?: ProviderAttemptEvidence[];
  };

  constructor(input: ModelFallbackAttemptError['attemptEvidence']) {
    super(
      `provider fallback failed for role '${input.role}': primary ${input.primaryModelId} ${input.failureKind} in ${input.primaryElapsedMs}ms; fallback ${input.fallbackModelId} ${input.fallbackFailureKind} in ${input.elapsedMs}ms; request=object/schema,maxOutputTokens=${input.requestProfile.maxOutputTokens ?? 'default'}`,
    );
    this.name = 'ModelFallbackAttemptError';
    this.attemptEvidence = input;
    this.cause = input.primaryFailure;
    this.errors = [input.fallbackFailure];
    if (input.attempts) attachProviderAttemptEvidence(this, input.attempts);
  }
}

/** Keeps both causes and the observed route attempts when a generic fallback fails. */
export class ModelCallFallbackAttemptError extends Error {
  readonly fallbackAttempted = true;
  readonly cause: unknown;
  readonly lastCause: unknown;
  readonly errors: unknown[];
  readonly attempts: ProviderAttemptEvidence[];

  constructor(
    primaryFailure: unknown,
    fallbackFailure: unknown,
    attempts: ProviderAttemptEvidence[],
  ) {
    super('configured model fallback attempt failed', { cause: primaryFailure });
    this.name = 'ModelCallFallbackAttemptError';
    this.cause = primaryFailure;
    this.lastCause = fallbackFailure;
    this.errors = [primaryFailure, fallbackFailure];
    this.attempts = attempts;
    attachProviderAttemptEvidence(this, attempts);
  }
}

export class ModelRouter {
  private readonly providers: ModelProviderSet;
  private readonly persistence: ModelRoutingRepository;
  private readonly configuredEmbeddingSpace?: Readonly<EmbeddingSpace>;
  private readonly fixedEmbeddingDimensions?: number;

  constructor(
    store: Db | ModelRoutingRepository,
    apiKey: string,
    /**
     * Whether to keep prompts and answers for quality review. Resolved once,
     * here, rather than read deep in the call path: capture policy is a
     * property of this router, and a constructor argument is what lets a test
     * exercise both modes against a memoized config.
     */
    private auditCapture: AuditCaptureMode = loadConfig().LLM_AUDIT_CAPTURE,
    /**
     * One pinned provider, or the owner's connected providers — each model
     * identity then resolves to the connection that serves it.
     */
    provider: ModelProvider | ModelProviderSet = createOpenRouterModelProvider(apiKey),
    embeddingSpace?: EmbeddingSpace,
    fixedEmbeddingDimensions?: number,
  ) {
    this.providers = isModelProviderSet(provider) ? provider : singleModelProviderSet(provider);
    if (embeddingSpace) validateEmbeddingSpace(embeddingSpace);
    if (
      fixedEmbeddingDimensions !== undefined &&
      (!Number.isInteger(fixedEmbeddingDimensions) || fixedEmbeddingDimensions < 1)
    ) {
      throw new Error('Invalid fixed embedding dimensions');
    }
    this.configuredEmbeddingSpace = embeddingSpace
      ? Object.freeze({ ...embeddingSpace })
      : undefined;
    this.fixedEmbeddingDimensions = fixedEmbeddingDimensions;
    this.persistence =
      'kind' in store && store.kind === 'model-routing-repository'
        ? (store as ModelRoutingRepository)
        : createPostgresModelRoutingRepository(store as Db);
  }

  /**
   * Budget snapshot for the guard. Daily/monthly spend comes from the unified
   * cost ledger (Phase 27) — model calls, embeddings, SMS, job-seconds — plus
   * estimated USD held by unreconciled reservations, so a launched job's
   * budget can't be double-spent before it reports actuals.
   */
  private async budgetSnapshot(taskId?: string) {
    const totals = await costTotals(this.persistence.costs);

    let taskLimitUsd: number | undefined;
    let taskSpentUsd: number | undefined;
    if (taskId) {
      const task = await this.persistence.taskBudget(taskId);
      if (task) {
        taskLimitUsd = Number(task.limit);
        taskSpentUsd = Number(task.spent);
      }
    }

    return {
      taskLimitUsd,
      taskSpentUsd,
      dailyLimitUsd: totals.dailyLimitUsd,
      dailySpentUsd: totals.dailySpentUsd,
      monthlyLimitUsd: totals.monthlyLimitUsd,
      monthlySpentUsd: totals.monthlySpentUsd,
      heldUsd: totals.heldUsd,
      softPct: totals.softPct,
    };
  }

  /** The adapter for one model identity; rejects models no connection serves. */
  private providerFor(modelId: string): ModelProvider {
    return this.providers.resolve(modelId);
  }

  /** Stable identity for the embedding provider/model/width and catalog revision. */
  async embeddingSpaceKey(): Promise<string> {
    return embeddingSpaceIdentityKey(await this.embeddingSpace());
  }

  /**
   * Resolve the immutable identity used by the next vector operation.
   * PostgreSQL stays fixed at 1536 dimensions; Firestore routers are pinned to
   * the complete configured identity. The PostgreSQL revision is the local
   * model-catalog update timestamp, not a provider-side weights attestation.
   */
  async embeddingSpace(): Promise<EmbeddingSpace> {
    const role = await this.persistence.role('embed');
    if (!role) throw new Error('no model_roles row for embedding space');
    const model = await this.persistence.model(role.primaryModel);
    if (!model?.enabled)
      throw new Error(`embedding model ${role.primaryModel} is disabled or unavailable`);
    await this.providers.refresh();
    const provider = this.providerFor(role.primaryModel);
    const space = this.configuredEmbeddingSpace ?? {
      provider: connectionIdForModel(role.primaryModel),
      model: role.primaryModel,
      dimensions:
        this.fixedEmbeddingDimensions ??
        provider.embeddingDimensions ??
        POSTGRES_EMBEDDING_DIMENSIONS,
      revision: catalogRevision(model.updatedAt),
    };
    this.assertEmbeddingSpace(space, role.primaryModel, provider.embeddingDimensions);
    return { ...space };
  }

  private assertEmbeddingSpace(
    space: EmbeddingSpace,
    modelId: string,
    providerDimensions?: number,
  ): void {
    validateEmbeddingSpace(space);
    if (space.model !== modelId && embeddingModelId(space) !== modelId) {
      throw new Error('Embedding model does not match the configured embedding space');
    }
    if (providerDimensions !== undefined && providerDimensions !== space.dimensions) {
      throw new Error('Embedding dimensions do not match the configured embedding space');
    }
  }

  /** Embed against a captured storage identity and return that identity for the atomic write. */
  async embedWithIdentity(
    values: string[],
    opts: {
      taskId?: string;
      abortSignal?: AbortSignal;
      expectedSpace?: EmbeddingSpace;
    } = {},
  ): Promise<{ embeddings: number[][]; space: EmbeddingSpace; spaceKey: string }> {
    // Capture before dispatch and keep the receipt tied to that capture even
    // when a caller changes its input object while the provider is in flight.
    const space = Object.freeze({ ...(opts.expectedSpace ?? (await this.embeddingSpace())) });
    const embeddings = await this.embed(values, { ...opts, expectedSpace: space });
    return { embeddings, space, spaceKey: embeddingSpaceIdentityKey(space) };
  }

  /** Resolve role → model through the capability matrix and the budget guard. */
  async route(role: ModelRole, opts: RouteOptions = {}): Promise<Route> {
    await this.providers.refresh();
    const decision = evaluateBudget(await this.budgetSnapshot(opts.taskId), {
      critical: opts.critical,
    });
    if (decision.mode === 'park' || decision.mode === 'block') {
      return { ok: false, decision };
    }

    const roleRow = await this.persistence.role(role);
    if (!roleRow) throw new Error(`no model_roles row for role: ${role}`);

    let primaryId = roleRow.primaryModel;
    let modelOverride = opts.modelOverride;
    // The conversation picker applies to tool-driven work as well as streamed
    // replies. Background planning/extraction keep their inexpensive role routes.
    if (
      !modelOverride &&
      !opts.modelOverrideResolved &&
      opts.taskId &&
      (role === 'reason' || role === 'draft')
    ) {
      modelOverride = (await this.persistence.conversationOverride(opts.taskId)) ?? undefined;
    }
    if (modelOverride) {
      const override = await this.persistence.model(modelOverride);
      if (override?.enabled && !(override.capabilities as { embedding?: boolean }).embedding) {
        primaryId = override.id;
      }
    }

    const params = (roleRow.params ?? {}) as Record<string, unknown>;
    const requestShape = opts.requestProfile ?? {
      tools: 'none' as const,
      output: 'text' as const,
      streaming: false,
    };
    let degraded = Boolean(opts.forceFallback) || decision.mode === 'fallback';
    let modelId = degraded ? roleRow.fallbackModel : primaryId;
    // Soft budget pressure chooses the least expensive member of this
    // explicitly configured quality-approved pair for this request estimate.
    // `forceFallback` remains a separate reliability/owner override and is not
    // silently rewritten by this economic comparison.
    if (
      !opts.forceFallback &&
      decision.mode === 'fallback' &&
      primaryId !== roleRow.fallbackModel
    ) {
      const [primaryCandidate, fallbackCandidate] = await Promise.all([
        this.persistence.model(primaryId),
        this.persistence.model(roleRow.fallbackModel),
      ]);
      if (primaryCandidate && fallbackCandidate) {
        const estimate = (candidate: typeof primaryCandidate) => {
          const inputTokens = estimatedInputTokens(opts as CallOptions);
          const output =
            opts.maxOutputTokens ??
            (params.maxOutputTokens as number | undefined) ??
            DEFAULT_MAX_OUTPUT_TOKENS[role as Exclude<ModelRole, 'embed'>];
          const promptRate = Number(candidate.promptCostPerMTok);
          const completionRate = Number(candidate.completionCostPerMTok);
          return (inputTokens * promptRate + output * completionRate) / 1_000_000;
        };
        const compatible = (candidate: typeof primaryCandidate) => {
          if (!candidate.enabled) return false;
          try {
            const candidateProvider = this.providerFor(candidate.id);
            const candidateCapabilities = (candidate.capabilities ?? {}) as { thinking?: boolean };
            const candidateReasoning = !candidateCapabilities.thinking
              ? 'unsupported'
              : candidateProvider.canDisableReasoning?.(candidate.id) &&
                  requestShape.tools === 'none' &&
                  !REASONING_ROLES.has(role as Exclude<ModelRole, 'embed'>)
                ? 'disabled'
                : 'enabled';
            const candidateProfile: ProviderRequestProfile = {
              ...requestShape,
              reasoning: candidateReasoning,
              privacy: 'deny',
              maxPrice: {
                prompt:
                  typeof (params.providerMaxPrice as { prompt?: unknown } | undefined)?.prompt ===
                  'number'
                    ? ((params.providerMaxPrice as { prompt: number }).prompt ??
                      Number(candidate.promptCostPerMTok))
                    : Number(candidate.promptCostPerMTok),
                completion:
                  typeof (params.providerMaxPrice as { completion?: unknown } | undefined)
                    ?.completion === 'number'
                    ? ((params.providerMaxPrice as { completion: number }).completion ??
                      Number(candidate.completionCostPerMTok))
                    : Number(candidate.completionCostPerMTok),
              },
            };
            return supportsFreshRequestProfile(candidate.capabilities, candidateProfile);
          } catch {
            return false;
          }
        };
        const primaryCompatible = compatible(primaryCandidate);
        const fallbackCompatible = compatible(fallbackCandidate);
        if (
          primaryCompatible &&
          (!fallbackCompatible || estimate(primaryCandidate) <= estimate(fallbackCandidate))
        ) {
          modelId = primaryId;
          degraded = false;
        } else if (fallbackCompatible) {
          modelId = roleRow.fallbackModel;
          degraded = modelId !== primaryId;
        }
      }
    }
    const modelRow = await this.persistence.model(modelId);
    if (!modelRow) throw new Error(`model row missing for routed model: ${modelId}`);
    if (!modelRow.enabled) throw new Error(`routed model is disabled: ${modelId}`);
    const promptCostPerMTok = Number(modelRow.promptCostPerMTok);
    const completionCostPerMTok = Number(modelRow.completionCostPerMTok);
    if (
      modelRow.promptCostPerMTok === null ||
      modelRow.completionCostPerMTok === null ||
      !Number.isFinite(promptCostPerMTok) ||
      !Number.isFinite(completionCostPerMTok)
    ) {
      throw new Error(`model ${modelId} is missing cost rates; refusing an unbudgeted call`);
    }
    const provider = this.providerFor(modelId);
    const capabilities = (modelRow.capabilities ?? {}) as { thinking?: boolean };
    const reasoning = !capabilities.thinking
      ? 'unsupported'
      : provider.canDisableReasoning?.(modelId) &&
          !(
            requestShape.tools !== 'none' ||
            REASONING_ROLES.has(role as Exclude<ModelRole, 'embed'>)
          )
        ? 'disabled'
        : 'enabled';
    const rolePrice = params.providerMaxPrice as
      | { prompt?: unknown; completion?: unknown; request?: unknown }
      | undefined;
    const price: ProviderRequestProfile['maxPrice'] = {
      prompt:
        typeof rolePrice?.prompt === 'number' && Number.isFinite(rolePrice.prompt)
          ? rolePrice.prompt
          : promptCostPerMTok,
      completion:
        typeof rolePrice?.completion === 'number' && Number.isFinite(rolePrice.completion)
          ? rolePrice.completion
          : completionCostPerMTok,
    };
    const requestLimits = [
      typeof rolePrice?.request === 'number' && Number.isFinite(rolePrice.request)
        ? rolePrice.request
        : undefined,
      typeof opts.maxEstimatedCostUsd === 'number' && Number.isFinite(opts.maxEstimatedCostUsd)
        ? opts.maxEstimatedCostUsd
        : undefined,
    ].filter((value): value is number => value !== undefined);
    if (requestLimits.length > 0) price.request = Math.min(...requestLimits);
    if (Object.values(price).some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`model role ${role} has an invalid provider price ceiling`);
    }
    const requestProfile: ProviderRequestProfile = {
      ...requestShape,
      reasoning,
      privacy: 'deny',
      maxPrice: price,
    };
    const supportedParameters = Array.isArray(
      (modelRow.capabilities as { supportedParameters?: unknown } | null)?.supportedParameters,
    )
      ? (modelRow.capabilities as { supportedParameters: unknown[] }).supportedParameters.filter(
          (parameter): parameter is string => typeof parameter === 'string',
        )
      : undefined;
    const checkedAt = (modelRow.capabilities as { checkedAt?: unknown } | null)?.checkedAt;
    const freshnessMs =
      typeof checkedAt === 'string' ? Date.now() - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
    if (supportedParameters && freshnessMs >= 0 && freshnessMs <= 30 * 24 * 60 * 60 * 1_000) {
      const missing = requiredProviderParameters(requestProfile).filter(
        (parameter) => !supportedParameters.includes(parameter),
      );
      if (missing.length > 0) {
        throw new Error(
          `model ${modelId} has no fresh capability evidence for required request parameters: ${missing.join(', ')}`,
        );
      }
    }

    return {
      ok: true,
      // require_parameters: OpenRouter must only route to providers that
      // support everything this request sends (json_schema response format,
      // tools, …). Without it a structured-output call is a lottery — e.g.
      // deepseek-chat is also served by providers with no structured-output
      // support, which hard-fail the request. Per-request semantics: plain
      // text calls still use the full provider pool.
      model: provider.chat(modelId, {
        interactive: isInteractiveRole(role),
        requestProfile,
      }),
      modelId,
      degraded,
      thinking: capabilities.thinking === true,
      decision,
      params,
      promptCostPerMTok,
      completionCostPerMTok,
      requestProfile,
    };
  }

  private outputLimit(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
  ): number {
    const configured = opts.maxOutputTokens ?? (route.params.maxOutputTokens as number | undefined);
    const requested = configured ?? DEFAULT_MAX_OUTPUT_TOKENS[role];
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('maxOutputTokens must be a positive finite number');
    }
    return Math.min(Math.floor(requested), HARD_MAX_OUTPUT_TOKENS);
  }

  /**
   * Whether this call should spend tokens on hidden reasoning.
   *
   * A model that cannot reason reports 'unsupported' so the provider sends no
   * reasoning parameter at all. Only a model verified to support disabling
   * reasoning may receive that request; required and unknown models keep it.
   */
  private reasoningMode(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    toolCall: boolean,
  ): ReasoningMode {
    if (!route.thinking) return 'unsupported';
    if (!this.providerFor(route.modelId).canDisableReasoning?.(route.modelId)) return 'enabled';
    return toolCall || REASONING_ROLES.has(role) ? 'enabled' : 'disabled';
  }

  /**
   * The completion budget to send the provider, plus any provider options.
   * A call that will reason gets bounded reasoning headroom on top of the
   * visible answer budget. Providers receive a token-budget hint or a supported
   * effort level; effort-only models do not guarantee a separate reasoning cap.
   * Callers must still handle finishReason 'length'. The inflated total
   * also flows into the cost reservation below — reasoning tokens are billed,
   * so reserving for them keeps the budget guard honest. Every other call gets
   * the visible limit alone.
   */
  private modelCallBudget(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
    toolCall: boolean,
  ): { maxOutputTokens: number; providerOptions?: ProviderOptions } {
    const visibleLimit = this.outputLimit(role, route, opts);
    const reasoning = this.reasoningMode(role, route, toolCall);
    // Headroom exists to keep reasoning from eating the visible answer, so it
    // is owed only to a call that will actually reason. Reserving it for one
    // that will not would also over-hold budget for tokens nobody generates.
    // Reasoning models still need it when a tool is mandatory: removing it can
    // exhaust the completion budget before the tool call is emitted.
    return {
      maxOutputTokens:
        reasoning === 'enabled' ? visibleLimit + REASONING_HEADROOM_TOKENS : visibleLimit,
      providerOptions: this.providerFor(route.modelId).optionsFor({
        reasoning,
        modelId: route.modelId,
      }),
    };
  }

  private async reserveModelCall(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
    toolCall: boolean,
  ) {
    const { maxOutputTokens, providerOptions } = this.modelCallBudget(role, route, opts, toolCall);
    const inputTokens = estimatedInputTokens(opts);
    const estimatedUsd = Math.max(
      0.000001,
      ((inputTokens * route.promptCostPerMTok + maxOutputTokens * route.completionCostPerMTok) /
        1_000_000) *
        ESTIMATE_SAFETY_FACTOR,
    );
    assertEstimatedCostWithinLimit(estimatedUsd, opts.maxEstimatedCostUsd);
    const reservation = await reserveCost(this.persistence.costs, {
      source: 'model',
      estimatedUsd,
      taskId: opts.taskId,
      description: `${role}:${route.modelId} preflight`,
      critical: opts.critical,
    });
    return { reservation, maxOutputTokens, providerOptions, estimatedUsd };
  }

  private async beginProviderAttempt(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
    reservationId: string,
    outputTokenLimit: number,
  ): Promise<void> {
    const metadata = {
      provider: connectionIdForModel(route.modelId),
      model: route.modelId,
      role,
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify({ system: opts.system, prompt: opts.prompt, messages: opts.messages }),
        )
        .digest('hex'),
      inputTokenEstimate: estimatedInputTokens(opts),
      outputTokenLimit,
      reasoning: this.reasoningMode(
        role,
        route,
        opts.requestProfile?.tools !== undefined && opts.requestProfile.tools !== 'none',
      ),
    } as const;
    if (!(await beginCostAttempt(this.persistence.costs, reservationId, metadata))) {
      throw new Error('Provider attempt reservation was already dispatched or closed');
    }
  }

  /**
   * Route and reserve a model call as one budget-aware decision. The routing
   * guard can only see money already spent; a large primary-model reservation
   * may still fail even when the task is below its soft threshold. Because no
   * provider work has happened at that point, retry the preflight with the
   * cheaper fallback before asking the owner for more budget.
   */
  private async prepareModelCall(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions,
    /** True only for a tool-carrying step, which keeps reasoning and the full deadline. */
    toolCall = false,
  ): Promise<
    | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
    | {
        ok: true;
        route: Extract<Route, { ok: true }>;
        reservationId: string;
        maxOutputTokens: number;
        providerOptions?: ProviderOptions;
        estimatedUsd: number;
      }
  > {
    const attempt = async (forceFallback: boolean) => {
      const route = await this.route(role, { ...opts, forceFallback });
      if (!route.ok) return { ok: false as const, decision: route.decision };
      const prepared = await this.reserveModelCall(role, route, opts, toolCall);
      if (!prepared.reservation.ok) {
        return {
          ok: false as const,
          decision: reservationDecision(prepared.reservation.reason),
          route,
        };
      }
      return {
        ok: true as const,
        route,
        reservationId: prepared.reservation.reservationId,
        maxOutputTokens: prepared.maxOutputTokens,
        providerOptions: prepared.providerOptions,
        estimatedUsd: prepared.estimatedUsd,
      };
    };

    const preferred = await attempt(Boolean(opts.forceFallback));
    if (preferred.ok || !preferred.route || preferred.route.degraded) return preferred;

    const fallback = await attempt(true);
    // A role may intentionally point primary and fallback at the same model.
    // Preserve the first failure instead of repeating the identical decision.
    if (fallback.route?.modelId === preferred.route.modelId) return preferred;
    return fallback;
  }

  /**
   * Run a prepare+call sequence, retrying ONCE when it dies on the per-call
   * deadline. Each OpenRouter request is load-balanced across upstream
   * providers, so a timeout is usually a per-request lottery loss (one slow
   * or degraded provider), not a property of the model — and without this,
   * that single slow request burns an entire task attempt: checkpoint reseed,
   * exponential backoff, and a re-billed context window. The retry re-runs
   * preparation, so budget routing and the cost reservation stay honest (the
   * timed-out try already released its hold). A caller whose own abortSignal
   * has fired is not retried — that deadline is not ours to extend.
   */
  private async withTimeoutRetry<T>(opts: CallOptions, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (opts.singleAttempt || !isModelCallTimeout(err) || opts.abortSignal?.aborted) throw err;
      const prior = getProviderAttemptEvidence(err);
      try {
        const retried = await run();
        return retried !== null && typeof retried === 'object'
          ? withAttemptEvidence(retried, prior)
          : retried;
      } catch (retryError) {
        attachProviderAttemptEvidence(retryError, [
          ...prior,
          ...getProviderAttemptEvidence(retryError),
        ]);
        throw retryError;
      }
    }
  }

  private async meter(input: MeterInput): Promise<void> {
    // The provider call already happened and must be accounted for, even if the
    // owner turned its connection off mid-call: metering never throws on that.
    let provider: ModelProvider | undefined;
    try {
      provider = this.providerFor(input.modelId);
    } catch {
      provider = undefined;
    }
    const normalized =
      input.usageOverride ??
      provider?.normalizeUsage(input.event) ??
      normalizeVertexUsage(input.event);
    const usage = {
      ...normalized,
      inputTokens: validTokenCount(normalized.inputTokens) ? normalized.inputTokens : undefined,
      outputTokens: validTokenCount(normalized.outputTokens) ? normalized.outputTokens : undefined,
      costUsd:
        typeof normalized.costUsd === 'number' &&
        Number.isFinite(normalized.costUsd) &&
        normalized.costUsd >= 0
          ? normalized.costUsd
          : undefined,
    };
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const completeTokenUsage = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
    const hasPositiveTokenUsage = completeTokenUsage && inputTokens + outputTokens > 0;
    // embedMany may split a batch into several provider calls. Its aggregate
    // providerMetadata is a shallow merge of the last chunk, so never treat
    // that one cost as the total charge for a multi-response result.
    let costUsd =
      !input.usageOverride && input.event.responses && input.event.responses.length > 1
        ? undefined
        : usage.costUsd;

    // Provider cost is authoritative. If it is absent, fail closed to the
    // configured rate table rather than silently treating a paid call as free.
    const costDescription = `${input.role}:${input.modelId}`;
    let basis: CostBasis = 'provider_reported';
    if (costUsd === undefined && hasPositiveTokenUsage) {
      basis = 'token_rate';
      costUsd =
        (inputTokens * input.promptCostPerMTok + outputTokens * input.completionCostPerMTok) /
        1_000_000;
    }
    if (costUsd === undefined) {
      await markCostAttemptUnknown(
        this.persistence.costs,
        input.reservationId,
        'provider returned without complete usage or authoritative cost',
        {
          ...(usage.generationId ? { requestId: usage.generationId } : {}),
          ...(usage.endpointName ? { endpoint: usage.endpointName } : {}),
        },
      );
      await this.recordForAudit(input, { inputTokens, outputTokens });
      return;
    }

    // Reconcile the budget hold first. If the secondary model-call telemetry
    // insert fails, spend is still safely accounted and the paid provider call
    // must not be repeated.
    await reconcileReservation(this.persistence.costs, input.reservationId, {
      evidence: {
        basis,
        provider: connectionIdForModel(input.modelId),
        model: input.modelId,
        ...(usage.generationId ? { requestId: usage.generationId } : {}),
        ...(usage.endpointName ? { endpoint: usage.endpointName } : {}),
        modelUsage: {
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.reasoningTokens !== undefined
            ? { reasoningTokens: usage.reasoningTokens }
            : {}),
          ...(usage.cacheReadInputTokens !== undefined
            ? { cacheReadInputTokens: usage.cacheReadInputTokens }
            : {}),
          ...(usage.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
            : {}),
          accounting: basis === 'provider_reported' ? 'provider-reported' : 'usage-rate-estimate',
        },
        ...(input.requestProfile
          ? {
              request: {
                providerPriceCeilingPerMTok: input.requestProfile.maxPrice,
                modelCatalogRatePerMTok: {
                  prompt: input.promptCostPerMTok,
                  completion: input.completionCostPerMTok,
                },
                rateSource: 'model-row-catalog',
                privacy: input.requestProfile.privacy,
                output: input.requestProfile.output,
                tools: input.requestProfile.tools,
                reasoning: input.requestProfile.reasoning,
                streaming: input.requestProfile.streaming,
              },
            }
          : {}),
      },
      usd: costUsd,
      ...(hasPositiveTokenUsage ? { quantity: inputTokens + outputTokens, unit: 'tokens' } : {}),
      unitPriceUsd: hasPositiveTokenUsage ? costUsd / (inputTokens + outputTokens) : undefined,
      description: costDescription,
    });
    const callId = await this.persistence.recordCall({
      taskId: input.taskId,
      role: input.role,
      model: input.modelId,
      ...modelCallRuntimeIdentity(),
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(6),
      latencyMs: input.latencyMs,
      finishReason: input.event.finishReason,
      openrouterGenerationId:
        provider?.kind === 'openrouter' ? (usage.generationId ?? input.event.response?.id) : null,
    });

    await this.recordForAudit(input, { callId, inputTokens, outputTokens });
  }

  /**
   * Keep what the model was asked and what it answered, when the owner has
   * turned capture on.
   *
   * Isolated in its own try/catch rather than riding on the caller's: this is
   * review telemetry, and it must never be able to mask a real metering failure
   * or, worse, make the workflow repeat paid model work. A row that does not
   * get written costs a line in a report; a throw here would cost a retry of
   * the provider call that already happened.
   */
  private async recordForAudit(
    input: Pick<MeterInput, 'taskId' | 'role' | 'modelId' | 'latencyMs' | 'event' | 'audit'>,
    usage: { callId?: string; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const { audit } = input;
    if (!audit) return;
    const mode = this.auditCapture;
    if (mode === 'off') return;

    try {
      const system = captureField(audit.system, mode);
      const promptInput = captureField(audit.input, mode);
      const output = captureField(audit.output, mode);
      await this.persistence.recordAudit({
        modelCallId: usage.callId,
        taskId: input.taskId,
        role: input.role,
        model: input.modelId,
        method: audit.method,
        capture: mode,
        systemPrompt: system.text ?? null,
        input: promptInput.text ?? null,
        output: output.text ?? null,
        truncated: system.truncated || promptInput.truncated || output.truncated,
        finishReason: input.event.finishReason,
        latencyMs: input.latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      console.error('model audit capture failed', err);
    }
  }

  /** Failed provider attempts need input context too, even when no billable call was returned. */
  private async recordFailureForAudit(
    role: ModelRole,
    modelId: string,
    method: AuditPayload['method'],
    opts: CallOptions,
    started: number,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error : new Error(String(error));
    const metadata = detail as Error & { statusCode?: number; isRetryable?: boolean };
    await this.recordForAudit(
      {
        taskId: opts.taskId,
        role,
        modelId,
        latencyMs: Date.now() - started,
        event: { finishReason: 'error' },
        audit: {
          method,
          system: opts.system,
          input: captureInput(opts),
          output: `[audit:provider-error] ${safeJson({ name: detail.name, message: detail.message, statusCode: metadata.statusCode, retryable: metadata.isRetryable })}`,
        },
      },
      { inputTokens: 0, outputTokens: 0 },
    );
  }

  private async meterWithoutRepeatingProviderWork(input: MeterInput): Promise<void> {
    try {
      await this.meter(input);
    } catch (err) {
      // The provider call already happened. Throwing here would make the
      // workflow repeat paid/non-idempotent model work. Keep the reservation
      // held as a conservative backstop; maintenance releases truly orphaned
      // holds after the crash window.
      console.error('model metering failed after provider success', err);
      let receipt: { requestId?: string; endpoint?: string } | undefined;
      try {
        const usage = this.providerFor(input.modelId).normalizeUsage(input.event);
        receipt = {
          ...(usage.generationId ? { requestId: usage.generationId } : {}),
          ...(usage.endpointName ? { endpoint: usage.endpointName } : {}),
        };
      } catch {
        // Reservation identity still allows later reconciliation when provider metadata is absent.
      }
      await markCostAttemptUnknown(
        this.persistence.costs,
        input.reservationId,
        'usage metering failed after provider success',
        receipt,
      ).catch(() => {});
    }
  }

  /** Non-streaming call with metering. Callers must handle { ok: false }. */
  async generate(role: ModelRole, opts: CallOptions): Promise<GenerateOutcome> {
    if (role === 'embed') throw new Error('generate() cannot use the embed role');
    opts = { ...opts, requestProfile: opts.requestProfile ?? textRequestProfile(false) };
    try {
      return await this.withTimeoutRetry(opts, () => this.generateOnce(role, opts));
    } catch (error) {
      if (opts.singleAttempt || opts.forceFallback || !isProviderCapabilityError(error))
        throw error;
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw error;
        const outcome = await this.withTimeoutRetry({ ...opts, forceFallback: true }, () =>
          this.generateOnce(role, { ...opts, forceFallback: true }),
        );
        if (!outcome.ok) throw error;
        return withAttemptEvidence(outcome, getProviderAttemptEvidence(error));
      } catch (fallbackError) {
        if (fallbackError === error) throw error;
        throw new ModelCallFallbackAttemptError(
          error,
          fallbackError,
          withAttemptEvidence(
            { attempts: getProviderAttemptEvidence(fallbackError) },
            getProviderAttemptEvidence(error),
          ).attempts,
        );
      }
    }
  }

  private async generateOnce(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions,
  ): Promise<GenerateOutcome> {
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const started = Date.now();
    const selection = opts.forceFallback ? 'fallback' : 'primary';
    try {
      return await withSpan('model.generate', { role, model: route.modelId }, async () => {
        await this.beginProviderAttempt(role, route, opts, reservationId, maxOutputTokens);
        const result = await generateText({
          model: route.model,
          maxRetries: opts.maxRetries,
          ...(opts.messages
            ? this.cacheHintedArgs(route.modelId, opts.system, opts.messages)
            : { system: opts.system, ...promptArgs(opts) }),
          temperature: opts.temperature ?? (route.params.temperature as number | undefined),
          maxOutputTokens,
          providerOptions,
          abortSignal: modelCallSignal(opts.abortSignal, role),
        });
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role,
          modelId: route.modelId,
          latencyMs: Date.now() - started,
          event: result as FinishEventLike,
          reservationId,
          estimatedUsd,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
          requestProfile: route.requestProfile,
          audit: {
            method: 'generate',
            system: opts.system,
            input: captureInput(opts),
            output: result.text,
          },
        });
        return {
          ok: true as const,
          modelId: route.modelId,
          degraded: route.degraded,
          text: result.text,
          finishReason: result.finishReason,
          attempts: [
            {
              method: 'generate',
              role,
              selection,
              modelId: route.modelId,
              ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
              elapsedMs: Date.now() - started,
              outcome: 'succeeded',
              fallbackAttempted: false,
            },
          ],
        };
      });
    } catch (err) {
      attachProviderAttemptEvidence(err, [
        {
          method: 'generate',
          role,
          selection,
          modelId: route.modelId,
          ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
          elapsedMs: Date.now() - started,
          outcome: 'failed',
          failureKind: providerFailureKind(err),
          fallbackAttempted: false,
        },
      ]);
      await this.recordFailureForAudit(role, route.modelId, 'generate', opts, started, err);
      await markCostAttemptUnknown(
        this.persistence.costs,
        reservationId,
        'model provider attempt failed',
      ).catch(() => {});
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
      throw err;
    }
  }

  /**
   * Streaming call. The AI SDK awaits onFinish, so metering and durable reply
   * persistence finish before the response stream is allowed to close.
   */
  async stream(
    role: ModelRole,
    opts: CallOptions & {
      onComplete?: (text: string) => Promise<void>;
      onError?: (error: unknown) => Promise<void>;
    },
  ): Promise<StreamOutcome> {
    if (role === 'embed') throw new Error('stream() cannot use the embed role');
    opts = { ...opts, requestProfile: opts.requestProfile ?? textRequestProfile(true) };
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const started = Date.now();
    const attempt: ProviderAttemptEvidence = {
      method: 'stream',
      role,
      selection: opts.forceFallback ? 'fallback' : 'primary',
      modelId: route.modelId,
      ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
      elapsedMs: 0,
      outcome: 'started',
      fallbackAttempted: false,
    };
    const attempts = [attempt];
    const finishAttempt = (outcome: 'succeeded' | 'failed', failure?: unknown) => {
      attempt.elapsedMs = Date.now() - started;
      attempt.outcome = outcome;
      if (failure !== undefined) {
        attempt.failureKind = providerFailureKind(failure);
        attachProviderAttemptEvidence(failure, attempts);
      }
    };
    let terminal: Promise<void> | undefined;
    const terminalOnce = (work: () => Promise<void>): Promise<void> => {
      if (!terminal) terminal = Promise.resolve().then(work);
      return terminal;
    };
    let result: ReturnType<typeof streamText>;
    try {
      await this.beginProviderAttempt(role, route, opts, reservationId, maxOutputTokens);
      result = streamText({
        maxRetries: opts.maxRetries,
        model: route.model,
        // Cache-hint the system prefix on the messages path (the owner's chat
        // turn is the highest-frequency call in the system, and re-billed the
        // whole system prompt every turn without this). Mirrors stepOnce.
        ...(opts.messages
          ? this.cacheHintedArgs(route.modelId, opts.system, opts.messages)
          : { system: opts.system, ...promptArgs(opts) }),
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        maxOutputTokens,
        providerOptions,
        abortSignal: modelCallSignal(opts.abortSignal, role),
        onFinish: async (event: FinishEventLike & { text?: string }) => {
          await terminalOnce(async () => {
            if (event.finishReason === 'error') {
              const failure = new Error('model stream finished with an error');
              finishAttempt('failed', failure);
            } else {
              finishAttempt('succeeded');
            }
            // AI SDK pauses stream finalization until this promise resolves.
            // Metering failures are contained so they cannot prevent reply persistence.
            await this.meterWithoutRepeatingProviderWork({
              taskId: opts.taskId,
              role,
              modelId: route.modelId,
              latencyMs: Date.now() - started,
              event,
              reservationId,
              estimatedUsd,
              promptCostPerMTok: route.promptCostPerMTok,
              completionCostPerMTok: route.completionCostPerMTok,
              requestProfile: route.requestProfile,
              audit: {
                method: 'stream',
                system: opts.system,
                input: captureInput(opts),
                output: event.text,
              },
            });
            if (event.finishReason === 'error') {
              const error = new Error('model stream finished with an error');
              if (opts.onError) {
                await opts.onError(error).catch((callbackError) => {
                  console.error('stream error callback failed', callbackError);
                });
              }
            } else {
              await opts.onComplete?.(event.text ?? '');
            }
          });
        },
        onError: async ({ error }: { error: unknown }) => {
          await terminalOnce(async () => {
            finishAttempt('failed', error);
            await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, error);
            await markCostAttemptUnknown(
              this.persistence.costs,
              reservationId,
              'stream provider attempt failed',
            ).catch(() => {});
            await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
            if (opts.onError) {
              await opts.onError(error).catch((callbackError) => {
                console.error('stream error callback failed', callbackError);
              });
            }
          });
        },
        onAbort: async () => {
          await terminalOnce(async () => {
            const error = new Error('model stream aborted');
            finishAttempt('failed', error);
            attempt.failureKind = 'aborted';
            await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, error);
            await markCostAttemptUnknown(
              this.persistence.costs,
              reservationId,
              'stream provider attempt aborted',
            ).catch(() => {});
            await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
            if (opts.onError) {
              await opts.onError(error).catch((callbackError) => {
                console.error('stream abort callback failed', callbackError);
              });
            }
          });
        },
      });
    } catch (err) {
      finishAttempt('failed', err);
      attachProviderAttemptEvidence(err, attempts);
      await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, err);
      await markCostAttemptUnknown(
        this.persistence.costs,
        reservationId,
        'stream provider call failed',
      ).catch(() => {});
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
      throw err;
    }

    const narrowed = result as unknown as {
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
      toUIMessageStream: (
        options?: Record<string, unknown>,
      ) => ReadableStream<unknown> & AsyncIterable<unknown>;
    };
    return {
      ok: true,
      modelId: route.modelId,
      degraded: route.degraded,
      attempts,
      text: narrowed.text,
      toUIMessageStreamResponse: (options) => narrowed.toUIMessageStreamResponse(options),
      toUIMessageStream: (options) => narrowed.toUIMessageStream(options),
    };
  }

  /**
   * One executor step: tools are passed WITHOUT execute functions, so the SDK
   * returns unexecuted tool calls — exactly what the risk gate needs.
   *
   * Tool names are wire-encoded here (see encodeToolNames): this project names
   * tools 'web.fetch', but several providers enforce the OpenAI function-name
   * pattern, which forbids dots and rejects the whole request. Encoding at the
   * model boundary keeps canonical dotted names everywhere else — the risk
   * gate, approvals, tool_calls rows and the response contract all still see
   * 'web.fetch'.
   */
  async step(
    role: ModelRole,
    opts: CallOptions & { tools: ToolSet; toolChoice?: StepToolChoice },
  ): Promise<StepCallOutcome> {
    if (role === 'embed') throw new Error('step() cannot use the embed role');
    opts = {
      ...withAdditionalInputTokens(opts, toolInputTokens(opts.tools)),
      requestProfile: opts.requestProfile ?? {
        tools: Object.keys(opts.tools).length > 0 ? 'required' : 'none',
        toolChoice: opts.toolChoice ?? 'auto',
        output: 'text',
        streaming: false,
      },
    };
    let outcome: StepCallOutcome;
    try {
      outcome = await this.withTimeoutRetry(opts, () => this.stepOnce(role, opts));
    } catch (error) {
      if (opts.singleAttempt || opts.forceFallback || !isProviderCapabilityError(error))
        throw error;
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw error;
        outcome = await this.withTimeoutRetry({ ...opts, forceFallback: true }, () =>
          this.stepOnce(role, { ...opts, forceFallback: true }),
        );
        if (!outcome.ok) throw error;
        outcome = withAttemptEvidence(outcome, getProviderAttemptEvidence(error));
      } catch (fallbackError) {
        // A provider-shape/billing failure gets one distinct configured-role
        // fallback. Preserve the original error so normal task retry and
        // diagnostics remain authoritative when the fallback cannot run.
        if (fallbackError === error) throw error;
        throw new ModelCallFallbackAttemptError(
          error,
          fallbackError,
          withAttemptEvidence(
            { attempts: getProviderAttemptEvidence(fallbackError) },
            getProviderAttemptEvidence(error),
          ).attempts,
        );
      }
    }
    // A tool decision is not owner-facing prose. Let its normal execution and
    // the step loop continue; only intercept obvious generation loops in a
    // text-only answer, leaving ordinary partial answers alone.
    const repetitionRequested = explicitlyRequestsRepetition(ownerRequestText(opts));
    if (
      !outcome.ok ||
      outcome.toolCalls.length > 0 ||
      !hasOutputIntegrityDefect(outcome.text, repetitionRequested)
    ) {
      return outcome;
    }

    if (opts.singleAttempt)
      return {
        ...outcome,
        text: MALFORMED_OUTPUT_FALLBACK,
        finishReason: 'error',
        qualityFailure: true,
      };

    let qualityRetryAttempts: ProviderAttemptEvidence[] = [];
    try {
      const fallbackRoute = await this.route(role, { ...opts, forceFallback: true });
      if (!fallbackRoute.ok || fallbackRoute.modelId === outcome.modelId) {
        return {
          ...outcome,
          text: MALFORMED_OUTPUT_FALLBACK,
          finishReason: 'error',
          qualityFailure: true,
        };
      }
      const retry = await this.withTimeoutRetry({ ...opts, forceFallback: true }, () =>
        this.stepOnce(role, { ...opts, forceFallback: true }),
      );
      qualityRetryAttempts = retry.ok ? (retry.attempts ?? []) : [];
      if (
        retry.ok &&
        (retry.toolCalls.length > 0 || !hasOutputIntegrityDefect(retry.text, repetitionRequested))
      )
        return withAttemptEvidence(retry, outcome.attempts ?? []);
    } catch (retryError) {
      qualityRetryAttempts = getProviderAttemptEvidence(retryError);
      // The already completed provider call is unusable; a bounded retry is
      // best-effort and must not turn this into a paid task retry loop.
    }
    return {
      ...outcome,
      text: MALFORMED_OUTPUT_FALLBACK,
      finishReason: 'error',
      qualityFailure: true,
      attempts: withAttemptEvidence({ attempts: qualityRetryAttempts }, outcome.attempts ?? [])
        .attempts,
    };
  }

  /**
   * Cache hints are withheld until the provider contract exposes an explicit
   * owner/policy/source/model scope. The prompt includes private owner context
   * and may change after an untrusted result, so a task-local cache marker is
   * not a sufficient retention boundary.
   */
  private cacheHintedArgs(
    modelId: string,
    system: string | undefined,
    messages: ModelMessage[],
  ): { messages: ModelMessage[]; allowSystemInMessages?: true; system?: string } {
    void modelId;
    return { ...(system ? { system } : {}), messages };
  }

  private async stepOnce(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions & { tools: ToolSet; toolChoice?: StepToolChoice },
  ): Promise<StepCallOutcome> {
    const prepared = await this.prepareModelCall(role, opts, true);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const { encoded, decode } = encodeToolNames(opts.tools);
    const toolChoice =
      opts.toolChoice && typeof opts.toolChoice === 'object'
        ? { ...opts.toolChoice, toolName: opts.toolChoice.toolName.replace(/\./g, '_') }
        : opts.toolChoice;

    const started = Date.now();
    const selection = opts.forceFallback ? 'fallback' : 'primary';
    try {
      return await withSpan('model.step', { role, model: route.modelId }, async () => {
        await this.beginProviderAttempt(role, route, opts, reservationId, maxOutputTokens);
        const result = await generateText({
          model: route.model,
          maxRetries: opts.maxRetries,
          ...(opts.messages
            ? this.cacheHintedArgs(
                route.modelId,
                opts.system,
                encodeMessageToolNames(opts.messages),
              )
            : { system: opts.system, ...promptArgs(opts) }),
          tools: encoded,
          toolChoice: toolChoice as never,
          temperature: opts.temperature ?? (route.params.temperature as number | undefined),
          maxOutputTokens,
          providerOptions,
          abortSignal: modelCallSignal(opts.abortSignal, role, true),
        });
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role,
          modelId: route.modelId,
          latencyMs: Date.now() - started,
          event: result as FinishEventLike,
          reservationId,
          estimatedUsd,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
          requestProfile: route.requestProfile,
          audit: {
            method: 'step',
            system: opts.system,
            input: captureInput(opts),
            // A step's answer is its prose *and* what it decided to call. A
            // record holding only the text would make every tool-calling turn
            // — most of the agent loop — look like it returned nothing.
            output: stepOutputForAudit(result.text, result.toolCalls),
          },
        });
        const toolCalls: ProposedToolCall[] = result.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: decode(tc.toolName),
          input: (tc.input ?? {}) as Record<string, unknown>,
        }));
        return {
          ok: true as const,
          modelId: route.modelId,
          degraded: route.degraded,
          text: result.text,
          toolCalls,
          finishReason: result.finishReason,
          attempts: [
            {
              method: 'step',
              role,
              selection,
              modelId: route.modelId,
              ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
              elapsedMs: Date.now() - started,
              outcome: 'succeeded',
              fallbackAttempted: false,
            },
          ],
        };
      });
    } catch (err) {
      attachProviderAttemptEvidence(err, [
        {
          method: 'step',
          role,
          selection,
          modelId: route.modelId,
          ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
          elapsedMs: Date.now() - started,
          outcome: 'failed',
          failureKind: providerFailureKind(err),
          fallbackAttempted: false,
        },
      ]);
      await this.recordFailureForAudit(role, route.modelId, 'step', opts, started, err);
      await markCostAttemptUnknown(
        this.persistence.costs,
        reservationId,
        'tool model attempt failed',
      ).catch(() => {});
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
      throw err;
    }
  }

  /** Structured output (planner, classifiers). Schema is a zod schema. */
  async object<T>(
    role: ModelRole,
    opts: CallOptions & { schema: ZodType<T> },
  ): Promise<ObjectOutcome<T>> {
    if (role === 'embed') throw new Error('object() cannot use the embed role');
    opts = {
      ...withAdditionalInputTokens(opts, schemaInputTokens(opts.schema)),
      requestProfile: opts.requestProfile ?? {
        tools: 'none',
        output: 'json_schema',
        streaming: false,
      },
    };

    const runOnce = async (
      forceFallback: boolean,
      maxTokensOverride?: number,
      callOpts: CallOptions & { schema: ZodType<T> } = opts,
    ): Promise<ObjectOutcome<T>> => {
      const prepared = await this.prepareModelCall(role, {
        ...callOpts,
        forceFallback: forceFallback || callOpts.forceFallback,
        ...(maxTokensOverride ? { maxOutputTokens: maxTokensOverride } : {}),
      });
      if (!prepared.ok) return prepared;
      const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

      const started = Date.now();
      const selection = forceFallback || callOpts.forceFallback ? 'fallback' : 'primary';
      try {
        return await withSpan('model.object', { role, model: route.modelId }, async () => {
          // OpenAI strict Structured Outputs requires every property to be required.
          // The router validates the parsed object against the caller's Zod schema,
          // so keep that local contract while allowing existing optional fields.
          const objectProviderOptions =
            this.providerFor(route.modelId).kind === 'openai'
              ? {
                  ...providerOptions,
                  openai: {
                    ...providerOptions?.openai,
                    strictJsonSchema: false,
                  },
                }
              : providerOptions;
          await this.beginProviderAttempt(role, route, callOpts, reservationId, maxOutputTokens);
          const result = await generateObject({
            maxRetries: callOpts.maxRetries,
            model: route.model,
            ...(callOpts.messages
              ? this.cacheHintedArgs(route.modelId, callOpts.system, callOpts.messages)
              : { system: callOpts.system, ...promptArgs(callOpts) }),
            schema: callOpts.schema,
            temperature: callOpts.temperature ?? (route.params.temperature as number | undefined),
            maxOutputTokens,
            providerOptions: objectProviderOptions,
            abortSignal: modelCallSignal(callOpts.abortSignal, role),
          });
          await this.meterWithoutRepeatingProviderWork({
            taskId: callOpts.taskId,
            role,
            modelId: route.modelId,
            latencyMs: Date.now() - started,
            event: result as unknown as FinishEventLike,
            reservationId,
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            requestProfile: route.requestProfile,
            audit: {
              method: 'object',
              system: callOpts.system,
              input: captureInput(callOpts),
              output: safeJson(result.object),
            },
          });
          return {
            ok: true as const,
            modelId: route.modelId,
            degraded: route.degraded,
            object: result.object as T,
            finishReason: result.finishReason,
            attempts: [
              {
                method: 'object',
                role,
                selection,
                modelId: route.modelId,
                ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
                elapsedMs: Date.now() - started,
                outcome: 'succeeded',
                fallbackAttempted: false,
              },
            ],
          };
        });
      } catch (err) {
        attachProviderAttemptEvidence(err, [
          {
            method: 'object',
            role,
            selection,
            modelId: route.modelId,
            ...(route.requestProfile ? { requestProfile: route.requestProfile } : {}),
            elapsedMs: Date.now() - started,
            outcome: 'failed',
            failureKind: providerFailureKind(err),
            fallbackAttempted: false,
          },
        ]);
        const providerEvent = providerResultFromError(err);
        if (providerEvent) {
          await this.meterWithoutRepeatingProviderWork({
            taskId: callOpts.taskId,
            role,
            modelId: route.modelId,
            latencyMs: Date.now() - started,
            event: providerEvent,
            reservationId,
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            requestProfile: route.requestProfile,
            audit: {
              method: 'object',
              system: callOpts.system,
              input: captureInput(callOpts),
              output: objectFailureAuditOutput(err),
            },
          });
        } else {
          await this.recordFailureForAudit(role, route.modelId, 'object', callOpts, started, err);
          await markCostAttemptUnknown(
            this.persistence.costs,
            reservationId,
            'structured model attempt failed',
          ).catch(() => {});
          await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
        }
        throw err;
      }
    };

    const attempt = (
      forceFallback: boolean,
      maxTokensOverride?: number,
      callOpts: CallOptions & { schema: ZodType<T> } = opts,
    ) => this.withTimeoutRetry(callOpts, () => runOnce(forceFallback, maxTokensOverride, callOpts));

    let outcome: ObjectOutcome<T>;
    const primaryStarted = Date.now();
    try {
      outcome = await attempt(false);
    } catch (err) {
      // Two error classes get one shot on the role's fallback model before
      // surfacing, because both are properties of the primary model rather
      // than transient: schema output a weak primary cannot parse
      // (AI_NoObjectGeneratedError), and provider-capability rejections
      // (e.g. "response format json_schema is not supported") where the
      // primary's provider pool cannot serve the request shape at all —
      // otherwise a durable job retries the same primary on every attempt
      // and dead-letters. Any other error (transport, 429/5xx) is genuinely
      // transient and is left to the caller's retry.
      if (
        opts.forceFallback ||
        !(
          isUnparseableObjectError(err) ||
          isProviderCapabilityError(err) ||
          (opts.fallbackOnTransientProviderError === true && isProviderTransientError(err))
        )
      ) {
        throw err;
      }
      const primaryElapsedMs = Date.now() - primaryStarted;
      const failureKind = isUnparseableObjectError(err)
        ? 'structured_output'
        : isProviderCapabilityError(err)
          ? 'provider_capability'
          : 'transient_provider';
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw err;
        const fallbackStarted = Date.now();
        try {
          const fallbackOpts =
            opts.fallbackOnTransientProviderError && isProviderTransientError(err)
              ? { ...opts, abortSignal: AbortSignal.timeout(60_000) }
              : opts;
          outcome = await attempt(true, undefined, fallbackOpts);
          // A fallback budget denial does not undo the dispatched primary.
          // Retain its evidence so durable callers cannot treat this as a
          // no-provider-work budget pause and blindly replay a paid attempt.
          outcome = withAttemptEvidence(outcome, getProviderAttemptEvidence(err));
        } catch (fallbackError) {
          throw new ModelFallbackAttemptError({
            role,
            primaryModelId: primary.modelId,
            fallbackModelId: fallback.modelId,
            primaryElapsedMs,
            elapsedMs: Date.now() - fallbackStarted,
            failureKind,
            fallbackFailureKind: isUnparseableObjectError(fallbackError)
              ? 'structured_output'
              : isProviderCapabilityError(fallbackError)
                ? 'provider_capability'
                : isProviderTransientError(fallbackError)
                  ? 'transient_provider'
                  : isProviderAuthDenial(fallbackError)
                    ? 'authentication'
                    : 'provider_rejected',
            requestProfile: {
              method: 'object',
              role,
              schema: true,
              ...(opts.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: opts.maxOutputTokens }),
              ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
            },
            primaryFailure: err,
            fallbackFailure: fallbackError,
            attempts: withAttemptEvidence(
              { attempts: getProviderAttemptEvidence(fallbackError) },
              getProviderAttemptEvidence(err),
            ).attempts,
          });
        }
      } catch (fallbackError) {
        if (fallbackError instanceof ModelFallbackAttemptError) throw fallbackError;
        // No usable fallback: preserve the original failure. A dispatched
        // fallback failure is represented by ModelFallbackAttemptError above.
        throw err;
      }
    }

    // Truncation guard: a schema-valid object can still be cut off at the token
    // limit (finishReason 'length') — the parse succeeds on a half-formed value.
    // Retry once on the fallback model with the largest allowed budget; if it
    // truncates again, fail typed so callers never render the fragment (the
    // "Are you" clarify bug — the plan role's 1024-token default was the cause).
    if (outcome.ok && outcome.finishReason === 'length') {
      const retryTokens = Math.max(opts.maxOutputTokens ?? 0, HARD_MAX_OUTPUT_TOKENS);
      // Preserve request/capability errors from the retry: a transport failure
      // is not evidence that the larger response was also truncated.
      const retried = await attempt(true, retryTokens);
      if (retried.ok && retried.finishReason !== 'length')
        return withAttemptEvidence(retried, outcome.attempts ?? []);
      if (!retried.ok)
        return {
          ...retried,
          // The truncation attempt succeeded; this budget decision only says
          // the follow-up call could not be reserved.
          attempts: outcome.attempts,
        }; // budget park/block — let the caller handle it
      const truncated = new TruncatedObjectError(role);
      attachProviderAttemptEvidence(
        truncated,
        withAttemptEvidence({ attempts: retried.attempts ?? [] }, outcome.attempts ?? []).attempts,
      );
      throw truncated;
    }
    return outcome;
  }

  /** Embeddings via the embed role. */
  async embed(
    values: string[],
    opts: {
      taskId?: string;
      abortSignal?: AbortSignal;
      expectedModelId?: string;
      expectedDimensions?: number;
      /** Immutable storage-space contract for this operation. */
      expectedSpace?: EmbeddingSpace;
    } = {},
  ): Promise<number[][]> {
    const expectedSpace = opts.expectedSpace
      ? Object.freeze({ ...opts.expectedSpace })
      : this.configuredEmbeddingSpace;
    if (values.length > 0 && opts.taskId) await this.persistence.taskBudget(opts.taskId);
    const roleRow = await this.persistence.role('embed');
    if (!roleRow) throw new Error('no model_roles row for role: embed');
    if (expectedSpace) {
      validateEmbeddingSpace(expectedSpace);
      if (
        this.configuredEmbeddingSpace &&
        embeddingSpaceIdentityKey(expectedSpace) !==
          embeddingSpaceIdentityKey(this.configuredEmbeddingSpace)
      ) {
        throw new Error('Embedding space identity does not match this router configuration');
      }
      const expectedModel = embeddingModelId(expectedSpace);
      if (roleRow.primaryModel !== expectedModel) {
        throw new Error('Embedding model does not match the configured embedding space');
      }
    }
    if (opts.expectedModelId && roleRow.primaryModel !== opts.expectedModelId)
      throw new Error('Embedding model does not match the configured embedding space');
    if (
      opts.expectedDimensions !== undefined &&
      (!Number.isInteger(opts.expectedDimensions) ||
        opts.expectedDimensions < 1 ||
        opts.expectedDimensions > 2_048)
    ) {
      throw new Error('Embedding dimensions must be an integer from 1 through 2048');
    }
    if (values.length === 0) return [];
    if (values.length > 100) throw new Error('embedding batch exceeds 100 values');
    const modelRow = await this.persistence.model(roleRow.primaryModel);
    if (!modelRow?.enabled) {
      throw new Error(`embedding model ${roleRow.primaryModel} is disabled or unavailable`);
    }
    if (
      expectedSpace &&
      !this.configuredEmbeddingSpace &&
      expectedSpace.revision !== catalogRevision(modelRow.updatedAt)
    ) {
      throw new Error('Embedding model revision does not match the captured embedding space');
    }
    if (
      !modelRow.capabilities ||
      typeof modelRow.capabilities !== 'object' ||
      (modelRow.capabilities as { embedding?: unknown }).embedding !== true
    ) {
      throw new Error(`embedding model ${roleRow.primaryModel} does not support embeddings`);
    }
    const promptCostPerMTok = Number(modelRow?.promptCostPerMTok);
    if (modelRow.promptCostPerMTok === null || !Number.isFinite(promptCostPerMTok)) {
      throw new Error(`embedding model ${roleRow.primaryModel} is missing a cost rate`);
    }
    await this.providers.refresh();
    const embeddingProvider = this.providerFor(roleRow.primaryModel);
    const operationSpace = expectedSpace ?? {
      provider: connectionIdForModel(roleRow.primaryModel),
      model: roleRow.primaryModel,
      dimensions:
        opts.expectedDimensions ??
        this.fixedEmbeddingDimensions ??
        embeddingProvider.embeddingDimensions ??
        POSTGRES_EMBEDDING_DIMENSIONS,
      revision: catalogRevision(modelRow.updatedAt),
    };
    if (
      this.fixedEmbeddingDimensions !== undefined &&
      operationSpace.dimensions !== this.fixedEmbeddingDimensions
    ) {
      throw new Error('Embedding dimensions do not match the fixed PostgreSQL vector width');
    }
    this.assertEmbeddingSpace(
      operationSpace,
      roleRow.primaryModel,
      embeddingProvider.embeddingDimensions,
    );
    const embeddingDimensions = operationSpace.dimensions;
    if (
      opts.expectedDimensions !== undefined &&
      opts.expectedDimensions !== operationSpace.dimensions
    ) {
      throw new Error('Embedding dimensions do not match the configured embedding space');
    }
    const inputTokens = Math.max(
      1,
      Math.ceil(values.reduce((n, value) => n + value.length, 0) / 2),
    );
    const estimatedUsd = Math.max(
      0.000001,
      ((inputTokens * promptCostPerMTok) / 1_000_000) * ESTIMATE_SAFETY_FACTOR,
    );
    const reservation = await reserveCost(this.persistence.costs, {
      source: 'embedding',
      estimatedUsd,
      taskId: opts.taskId,
      description: `embed:${roleRow.primaryModel} preflight`,
    });
    if (!reservation.ok) throw new BudgetReservationError(reservation.reason, reservation.resumeAt);

    const started = Date.now();
    let providerSucceeded = false;
    let metered = false;
    const providerEvidence: EmbeddingProviderEvidence[] = [];
    let observation: ReturnType<typeof observeEmbeddingModel> | undefined;
    try {
      if (
        !(await beginCostAttempt(this.persistence.costs, reservation.reservationId, {
          provider: connectionIdForModel(roleRow.primaryModel),
          model: roleRow.primaryModel,
          role: 'embed',
          requestDigest: createHash('sha256')
            .update(JSON.stringify([embeddingSpaceIdentityKey(operationSpace), values]))
            .digest('hex'),
          inputTokenEstimate: inputTokens,
          outputTokenLimit: 0,
          reasoning: 'unsupported',
        }))
      )
        throw new Error('Embedding reservation was already dispatched or closed');
      observation = observeEmbeddingModel(
        embeddingProvider.textEmbeddingModel(roleRow.primaryModel),
        providerEvidence,
      );
      const { embeddings, usage, providerMetadata, responses } = await embedMany({
        model: observation.model,
        values,
        maxParallelCalls: 4,
        providerOptions: embeddingProvider.embeddingOptions(),
        abortSignal: modelCallSignal(opts.abortSignal),
      });
      providerSucceeded = true;
      const event = {
        usage: usage ? { inputTokens: usage.tokens, outputTokens: 0 } : undefined,
        providerMetadata,
        responses,
      };
      const usageOverride = aggregateEmbeddingUsage(embeddingProvider, providerEvidence);
      await this.meterWithoutRepeatingProviderWork({
        taskId: opts.taskId,
        role: 'embed',
        modelId: roleRow.primaryModel,
        latencyMs: Date.now() - started,
        event,
        reservationId: reservation.reservationId,
        estimatedUsd,
        usageOverride,
        promptCostPerMTok,
        completionCostPerMTok: 0,
      });
      metered = true;

      // Account for the successful provider call before inspecting its
      // result. A malformed response is still paid work, and validation must
      // never throw before metering can reconcile the reservation.
      const vectorList = Array.isArray(embeddings) ? embeddings : undefined;
      const invalid = vectorList?.findIndex((embedding) => {
        if (!Array.isArray(embedding) || embedding.length !== embeddingDimensions) {
          return true;
        }
        for (let index = 0; index < embedding.length; index += 1) {
          if (!(index in embedding) || !Number.isFinite(embedding[index])) return true;
        }
        return false;
      });
      if (!vectorList) {
        throw new Error('embedding provider returned a non-array result');
      }
      if (vectorList.length !== values.length) {
        throw new Error(
          `embedding provider returned ${vectorList.length} vectors for ${values.length} values`,
        );
      }
      if (invalid !== undefined && invalid !== -1) {
        throw new Error(`embedding provider returned an invalid vector at index ${invalid}`);
      }
      return vectorList as number[][];
    } catch (err) {
      observation?.stop();
      await observation?.waitForSettled();
      if (!providerSucceeded && providerEvidence.length > 0 && !metered) {
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role: 'embed',
          modelId: roleRow.primaryModel,
          latencyMs: Date.now() - started,
          event: { responses: providerEvidence },
          reservationId: reservation.reservationId,
          estimatedUsd,
          usageOverride: aggregateEmbeddingUsage(embeddingProvider, providerEvidence),
          promptCostPerMTok,
          completionCostPerMTok: 0,
        });
        metered = true;
      }
      if (!providerSucceeded && !metered) {
        await markCostAttemptUnknown(
          this.persistence.costs,
          reservation.reservationId,
          'embedding provider attempt failed',
        ).catch(() => {});
        await releaseReservation(this.persistence.costs, reservation.reservationId).catch(() => {});
      }
      throw err;
    }
  }
}
