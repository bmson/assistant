import { loadConfig } from '@assistant/config';
import { createPostgresModelRoutingRepository, type Db } from '@assistant/db';
import type { CostBasis, ModelRoutingRepository } from '@assistant/persistence';
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
import type { ZodType } from 'zod';
import {
  BudgetReservationError,
  costTotals,
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
  type ModelProvider,
  normalizeVertexUsage,
  type ProviderOptions,
  type ProviderUsage,
  type ReasoningMode,
} from './provider.js';

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
    }
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> };

export interface CallOptions {
  taskId?: string;
  modelOverride?: string;
  /** Use this role's configured fallback model even when the budget is healthy. */
  forceFallback?: boolean;
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
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | { ok: true; modelId: string; degraded: boolean; text: string; finishReason?: string };

/** A proposed (unexecuted) tool call — the executor feeds these to the risk gate. */
export interface ProposedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type StepCallOutcome =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: string;
      toolCalls: ProposedToolCall[];
      finishReason?: string;
      /** A repeated-generation guard exhausted its single fallback attempt. */
      qualityFailure?: true;
    };

export type ObjectOutcome<T> =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | { ok: true; modelId: string; degraded: boolean; object: T; finishReason?: string };

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
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
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
  const pending: unknown[] = [err];
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && pending.length > 0; depth += 1) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (candidate instanceof Error && candidate.name === 'AI_APICallError') {
      const statusCode = record.statusCode;
      const paymentRequired =
        statusCode === 402 ||
        statusCode === '402' ||
        /\bpayment method is required\b/i.test(candidate.message);
      const modelRemoved = statusCode === 410 || statusCode === '410';
      if (
        paymentRequired ||
        modelRemoved ||
        /not supported|no endpoints? (found|match)|no allowed providers/i.test(candidate.message)
      ) {
        return true;
      }
    }
    pending.push(record.lastError, record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors.slice(0, 4));
  }
  return false;
}

export class ModelRouter {
  private readonly providers: ModelProviderSet;
  private readonly persistence: ModelRoutingRepository;

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
  ) {
    this.providers = isModelProviderSet(provider) ? provider : singleModelProviderSet(provider);
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

    const degraded = opts.forceFallback || decision.mode === 'fallback';
    const modelId = degraded ? roleRow.fallbackModel : primaryId;
    const params = (roleRow.params ?? {}) as Record<string, unknown>;
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

    return {
      ok: true,
      // require_parameters: OpenRouter must only route to providers that
      // support everything this request sends (json_schema response format,
      // tools, …). Without it a structured-output call is a lottery — e.g.
      // deepseek-chat is also served by providers with no structured-output
      // support, which hard-fail the request. Per-request semantics: plain
      // text calls still use the full provider pool.
      model: provider.chat(modelId, { interactive: isInteractiveRole(role) }),
      modelId,
      degraded,
      thinking: capabilities.thinking === true,
      decision,
      params,
      promptCostPerMTok,
      completionCostPerMTok,
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
      if (!isModelCallTimeout(err) || opts.abortSignal?.aborted) throw err;
      return await run();
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
    let costDescription = `${input.role}:${input.modelId}`;
    let basis: CostBasis = 'provider_reported';
    if (costUsd === undefined && hasPositiveTokenUsage) {
      basis = 'token_rate';
      costUsd =
        (inputTokens * input.promptCostPerMTok + outputTokens * input.completionCostPerMTok) /
        1_000_000;
    }
    if (costUsd === undefined) {
      basis = 'preflight_estimate';
      // A successful provider call with no usage is still paid work. Reconcile
      // to the positive preflight estimate so the hold cannot be refunded as
      // zero; the description keeps the conservative accounting visible.
      costUsd = input.estimatedUsd;
      costDescription = `${costDescription} estimated: provider usage unavailable`;
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
    }
  }

  /** Non-streaming call with metering. Callers must handle { ok: false }. */
  async generate(role: ModelRole, opts: CallOptions): Promise<GenerateOutcome> {
    if (role === 'embed') throw new Error('generate() cannot use the embed role');
    try {
      return await this.withTimeoutRetry(opts, () => this.generateOnce(role, opts));
    } catch (error) {
      if (opts.forceFallback || !isProviderCapabilityError(error)) throw error;
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw error;
        const outcome = await this.withTimeoutRetry({ ...opts, forceFallback: true }, () =>
          this.generateOnce(role, { ...opts, forceFallback: true }),
        );
        if (!outcome.ok) throw error;
        return outcome;
      } catch {
        // Keep the primary's permanent rejection authoritative if fallback cannot run.
        throw error;
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
    try {
      return await withSpan('model.generate', { role, model: route.modelId }, async () => {
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
        };
      });
    } catch (err) {
      await this.recordFailureForAudit(role, route.modelId, 'generate', opts, started, err);
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
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const started = Date.now();
    let terminal: Promise<void> | undefined;
    const terminalOnce = (work: () => Promise<void>): Promise<void> => {
      if (!terminal) terminal = Promise.resolve().then(work);
      return terminal;
    };
    let result: ReturnType<typeof streamText>;
    try {
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
            await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, error);
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
            await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, error);
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
      await this.recordFailureForAudit(role, route.modelId, 'stream', opts, started, err);
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
    let outcome: StepCallOutcome;
    try {
      outcome = await this.withTimeoutRetry(opts, () => this.stepOnce(role, opts));
    } catch (error) {
      if (opts.forceFallback || !isProviderCapabilityError(error)) throw error;
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw error;
        outcome = await this.withTimeoutRetry({ ...opts, forceFallback: true }, () =>
          this.stepOnce(role, { ...opts, forceFallback: true }),
        );
        if (!outcome.ok) throw error;
      } catch {
        // A provider-shape/billing failure gets one distinct configured-role
        // fallback. Preserve the original error so normal task retry and
        // diagnostics remain authoritative when the fallback cannot run.
        throw error;
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
      if (
        retry.ok &&
        (retry.toolCalls.length > 0 || !hasOutputIntegrityDefect(retry.text, repetitionRequested))
      )
        return retry;
    } catch {
      // The already completed provider call is unusable; a bounded retry is
      // best-effort and must not turn this into a paid task retry loop.
    }
    return {
      ...outcome,
      text: MALFORMED_OUTPUT_FALLBACK,
      finishReason: 'error',
      qualityFailure: true,
    };
  }

  /**
   * Prompt-caching hints for the step loop. The system prompt is stable within
   * a task run and the transcript grows append-only, so two cache_control
   * breakpoints — after the system prompt and on the newest message — let each
   * step read the previous step's entire prefix from provider cache instead of
   * re-billing it. Anthropic models need the explicit breakpoints (via
   * OpenRouter); OpenAI-family models cache prefixes automatically and ignore
   * the hint.
   *
   * Returned as call arguments, not a bare messages array: the system prompt
   * has to ride inside `messages` (a system-role message is the only shape
   * that can carry a per-message cache_control providerOption), and AI SDK v7
   * rejects that with AI_InvalidPromptError unless `allowSystemInMessages` is
   * set. Bundling the flag with the messages makes it impossible for a call
   * site to take the hinted messages and forget the opt-in.
   */
  private cacheHintedArgs(
    modelId: string,
    system: string | undefined,
    messages: ModelMessage[],
  ): { messages: ModelMessage[]; allowSystemInMessages?: true; system?: string } {
    const hint = this.providerFor(modelId).cacheHint();
    if (!hint) return { ...(system ? { system } : {}), messages };
    const hinted = [...messages];
    const last = hinted[hinted.length - 1];
    if (last) {
      // A tool message may hold an entire batch of results. Message-level
      // cache options are copied onto every result by the provider, exceeding
      // its cache-breakpoint limit. Mark only the final content block.
      hinted[hinted.length - 1] = Array.isArray(last.content)
        ? ({
            ...last,
            content: last.content.map((part, index) =>
              index === last.content.length - 1
                ? {
                    ...part,
                    providerOptions: {
                      ...('providerOptions' in part ? part.providerOptions : {}),
                      ...hint,
                    },
                  }
                : part,
            ),
          } as ModelMessage)
        : ({ ...last, providerOptions: { ...last.providerOptions, ...hint } } as ModelMessage);
    }
    return {
      messages: system
        ? [{ role: 'system', content: system, providerOptions: hint } as ModelMessage, ...hinted]
        : hinted,
      allowSystemInMessages: true,
    };
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
    try {
      return await withSpan('model.step', { role, model: route.modelId }, async () => {
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
        };
      });
    } catch (err) {
      await this.recordFailureForAudit(role, route.modelId, 'step', opts, started, err);
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

    const runOnce = async (
      forceFallback: boolean,
      maxTokensOverride?: number,
    ): Promise<ObjectOutcome<T>> => {
      const prepared = await this.prepareModelCall(role, {
        ...opts,
        forceFallback: forceFallback || opts.forceFallback,
        ...(maxTokensOverride ? { maxOutputTokens: maxTokensOverride } : {}),
      });
      if (!prepared.ok) return prepared;
      const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

      const started = Date.now();
      try {
        return await withSpan('model.object', { role, model: route.modelId }, async () => {
          const result = await generateObject({
            maxRetries: opts.maxRetries,
            model: route.model,
            ...(opts.messages
              ? this.cacheHintedArgs(route.modelId, opts.system, opts.messages)
              : { system: opts.system, ...promptArgs(opts) }),
            schema: opts.schema,
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
            event: result as unknown as FinishEventLike,
            reservationId,
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            audit: {
              method: 'object',
              system: opts.system,
              input: captureInput(opts),
              output: safeJson(result.object),
            },
          });
          return {
            ok: true as const,
            modelId: route.modelId,
            degraded: route.degraded,
            object: result.object as T,
            finishReason: result.finishReason,
          };
        });
      } catch (err) {
        const providerEvent = providerResultFromError(err);
        if (providerEvent) {
          await this.meterWithoutRepeatingProviderWork({
            taskId: opts.taskId,
            role,
            modelId: route.modelId,
            latencyMs: Date.now() - started,
            event: providerEvent,
            reservationId,
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            audit: {
              method: 'object',
              system: opts.system,
              input: captureInput(opts),
              output: objectFailureAuditOutput(err),
            },
          });
        } else {
          await this.recordFailureForAudit(role, route.modelId, 'object', opts, started, err);
          await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
        }
        throw err;
      }
    };

    const attempt = (forceFallback: boolean, maxTokensOverride?: number) =>
      this.withTimeoutRetry(opts, () => runOnce(forceFallback, maxTokensOverride));

    let outcome: ObjectOutcome<T>;
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
        !(isUnparseableObjectError(err) || isProviderCapabilityError(err))
      ) {
        throw err;
      }
      try {
        const primary = await this.route(role, { ...opts, forceFallback: false });
        const fallback = await this.route(role, { ...opts, forceFallback: true });
        if (!primary.ok || !fallback.ok || primary.modelId === fallback.modelId) throw err;
        outcome = await attempt(true);
      } catch {
        // No usable fallback, or it also failed: surface the original
        // failure so the caller can skip this item.
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
      if (retried.ok && retried.finishReason !== 'length') return retried;
      if (!retried.ok) return retried; // budget park/block — let the caller handle it
      throw new TruncatedObjectError(role);
    }
    return outcome;
  }

  /** Embeddings via the embed role. */
  async embed(
    values: string[],
    opts: { taskId?: string; abortSignal?: AbortSignal; expectedModelId?: string } = {},
  ): Promise<number[][]> {
    if (values.length > 0 && opts.taskId) await this.persistence.taskBudget(opts.taskId);
    const roleRow = await this.persistence.role('embed');
    if (!roleRow) throw new Error('no model_roles row for role: embed');
    if (opts.expectedModelId && roleRow.primaryModel !== opts.expectedModelId)
      throw new Error('Embedding model does not match the configured embedding space');
    if (values.length === 0) return [];
    if (values.length > 100) throw new Error('embedding batch exceeds 100 values');
    const modelRow = await this.persistence.model(roleRow.primaryModel);
    const promptCostPerMTok = Number(modelRow?.promptCostPerMTok);
    if (!modelRow || modelRow.promptCostPerMTok === null || !Number.isFinite(promptCostPerMTok)) {
      throw new Error(`embedding model ${roleRow.primaryModel} is missing a cost rate`);
    }
    await this.providers.refresh();
    const embeddingProvider = this.providerFor(roleRow.primaryModel);
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
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
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
        await releaseReservation(this.persistence.costs, reservation.reservationId).catch(() => {});
      }
      throw err;
    }
  }
}
