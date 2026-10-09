import { z } from 'zod';
import { CueSchema } from './chat-cues.js';
import {
  RequestChecklistSchema,
  RequestedOutcomeSchema,
} from './workflow/request-checklist-schema.js';

/** Where the assistant's trust in a piece of content or a trigger comes from. */
export const TrustSchema = z.enum(['owner', 'known', 'unknown', 'assistant']);
export type Trust = z.infer<typeof TrustSchema>;

export const OwnerIntentScopeSchema = z.enum([
  'external_read',
  'private_read',
  'external_send',
  'workspace_write',
  'personal_write',
  'watch_create',
  'private_write',
  'memory_write',
  'feedback_write',
]);
export type ClarificationScope = z.infer<typeof OwnerIntentScopeSchema>;

/** A clarification continuation is sourced from an owned prior task checkpoint. */
export const ClarificationContinuationSchema = z.object({
  sourceTaskId: z.string().min(1).max(128),
  ownerAuthoredText: z.string().max(8_000),
  question: z.string().min(1).max(2_000),
  authorizedScopes: z.array(OwnerIntentScopeSchema).max(9),
  tainted: z.boolean(),
  answerStatus: z.enum(['answer', 'refusal', 'deferred', 'uncertain', 'unrelated']),
});
export type ClarificationContinuation = z.infer<typeof ClarificationContinuationSchema>;

export const ClarificationPromptSchema = z.object({
  version: z.literal(1),
  question: z.string().min(1).max(2_000),
  ownerAuthoredText: z.string().max(8_000),
  authorizedScopes: z.array(OwnerIntentScopeSchema).max(9),
  tainted: z.boolean(),
});
export type ClarificationPrompt = z.infer<typeof ClarificationPromptSchema>;

export const EventSourceSchema = z.enum([
  'chat',
  'sms',
  'email',
  'schedule',
  'approval',
  'mission_wake',
  'internal',
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * Every event source (chat POST, Twilio webhook, Gmail push, Scheduler tick,
 * approval resolution, mission wake) normalizes to this envelope before a
 * workflow is enqueued. The runtime does not care where work came from.
 */
export const InboundEventSchema = z.object({
  source: EventSourceSchema,
  /** Idempotency key for event → task creation (Gmail msgId, Twilio SID, ...). */
  externalEventId: z.string().optional(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  trust: TrustSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;

/**
 * Payload key recording that the chat route's own triage ruled this turn an
 * action before handing it to the executor.
 *
 * The planner opens with nearly the same question — "does this need
 * planning/tools, or is it trivial chat?" — so asking a second model costs a
 * round trip in front of work the owner is waiting on, for an answer already
 * in hand.
 *
 * Only an AFFIRMATIVE ruling is recorded. That route also lands on "action" as
 * its safe default when its own triage fails to answer, and that default is
 * not evidence of anything: skipping the planner's check there would send a
 * possibly-trivial message straight to the planner's slow model, which is
 * worse than the cheap classify it replaced. Absent the key, nothing changes.
 */
export const TRIAGED_ACTIONABLE = 'triagedActionable';

/** Did the chat route affirmatively rule this task's turn an action? */
export function wasTriagedActionable(trigger: unknown): boolean {
  const payload = (trigger as { payload?: Record<string, unknown> } | null | undefined)?.payload;
  return payload?.[TRIAGED_ACTIONABLE] === true;
}

/** Planner output — the planner decides, it never executes. */
function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const MissionCadenceSchema = z
  .union([
    z.object({
      kind: z.literal('interval'),
      /** Fixed elapsed-time interval. Delayed wakes skip missed intervals. */
      everyMinutes: z.number().int().min(15).max(10_080),
    }),
    z.object({
      kind: z.literal('local_times'),
      /** IANA timezone used for daylight-saving and wall-clock calculations. */
      timezone: z.string().min(1).max(100).refine(isTimezone, 'must be a valid IANA timezone'),
      /** Local HH:mm times, once each on each selected day. */
      times: z
        .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
        .min(1)
        .max(8),
      /** Sunday=0 through Saturday=6; omitted means every day. */
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    }),
  ])
  .superRefine((cadence, context) => {
    if (cadence.kind === 'local_times') {
      if (new Set(cadence.times).size !== cadence.times.length)
        context.addIssue({ code: 'custom', path: ['times'], message: 'times must be unique' });
      if (cadence.daysOfWeek && new Set(cadence.daysOfWeek).size !== cadence.daysOfWeek.length)
        context.addIssue({
          code: 'custom',
          path: ['daysOfWeek'],
          message: 'daysOfWeek must be unique',
        });
    }
  });
export type MissionCadence = z.infer<typeof MissionCadenceSchema>;

export const PlanSchema = z.object({
  action: z.enum(['reply', 'workflow', 'mission', 'schedule', 'clarify']),
  reasoning: z.string().default(''),
  steps: z.array(z.string()).default([]),
  requestedOutcomes: z.array(RequestedOutcomeSchema).max(12).optional(),
  missingInfo: z.array(z.string()).default([]),
  goalId: z.string().uuid().optional(),
  deadline: z.string().optional(),
  budgetSuggestionUsd: z.number().optional(),
  /** Durable cadence for an ongoing mission; absence retains the daily interval default. */
  cadence: MissionCadenceSchema.optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Authoritative task checkpoint. contextWindow is the compacted working
 * context — full tool results live once in tool_calls and are referenced here.
 */
/**
 * A parked approval: approvalId is the approvals row; toolCallId is the
 * MODEL's tool-call id (needed to stitch the result back into the transcript);
 * dbToolCallId is the tool_calls row to execute on approval.
 */
export const PendingApprovalSchema = z.object({
  approvalId: z.string(),
  toolCallId: z.string(),
  dbToolCallId: z.string(),
  toolName: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/**
 * A launched-and-awaited browser job: the task sleeps while the Playwright
 * job runs; the job's one-shot-token callback (or the timeout backstop)
 * wakes it, and the executor stitches the result from the tool_calls row.
 */
export const PendingJobSchema = z.object({
  dbToolCallId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  /** SHA-256 of the one-shot callback token — never the raw token (see hashCallbackToken). */
  callbackTokenHash: z.string(),
  timeoutAt: z.string(),
});
export type PendingJob = z.infer<typeof PendingJobSchema>;

/** Ordered continuation for one model-emitted tool batch. */
export const PendingToolBatchCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'awaiting_approval', 'budget', 'job', 'settled']).default('queued'),
  dbToolCallId: z.string().optional(),
  approvalId: z.string().optional(),
});
export const PendingToolBatchSchema = z.object({
  step: z.number().int().nonnegative(),
  modelId: z.string().default('unknown'),
  calls: z.array(PendingToolBatchCallSchema).min(1),
});
export type PendingToolBatchCall = z.infer<typeof PendingToolBatchCallSchema>;
export type PendingToolBatch = z.infer<typeof PendingToolBatchSchema>;

/**
 * A final response is checkpointed before channel delivery. If the provider
 * fails (or the process crashes), a retry delivers this exact text instead of
 * asking the model again and potentially producing duplicate/inconsistent
 * replies.
 */
export const PendingFinalSchema = z.object({
  completionKind: z.literal('successful_silent').optional(),
  text: z.string(),
  progress: z.string(),
  // 'needs_attention' is terminal-for-now rather than terminal: an unattended
  // goal session that verified nothing parks here so the owner can see it,
  // and the Tasks page can re-queue it once they have acted.
  terminalStatus: z.enum(['done', 'failed', 'needs_attention']),
  outcome: z.enum(['done', 'clarify', 'failed', 'needs_attention']),
  /** Legacy at-most-once marker; new records use finalDelivery. */
  deliveryAttempted: z.boolean().optional(),
  deliveryAttempts: z.number().int().min(0).optional(),
  /** Durable typed receipt for the external final-answer channel attempt. */
  finalDelivery: z
    .object({
      legs: z
        .array(
          z.object({
            channel: z.string().min(1).max(80),
            status: z.enum(['not_applicable', 'accepted', 'rejected', 'unknown']),
            attemptId: z.string().min(1).max(256),
            reason: z.string().max(200).optional(),
          }),
        )
        .min(1)
        .max(8),
    })
    .optional(),
  /** True when the task is parked only because the last channel delivery was rejected/unknown. */
  deliveryNeedsAttention: z.boolean().optional(),
  /** Response-contract verdict, persisted to response_checks at finalize. */
  contractBlocked: z.boolean().optional(),
  contractUnsupportedCount: z.number().int().optional(),
  /** Best-effort self-review before the final deterministic contract pass. */
  outputVerificationAttempted: z.boolean().optional(),
  outputVerificationRevised: z.boolean().optional(),
  outputVerificationUnavailable: z.boolean().optional(),
  /**
   * The response contract replaced the model's draft with its own honest
   * fallback — the chat UI renders such messages as a compact system notice
   * instead of assistant prose. Additive: old checkpoints parse unchanged.
   */
  contractNotice: z.boolean().optional(),
  /**
   * Companion cues stripped out of a dashboard chat_turn's final text
   * (chat-cues.ts); persisted into the reply's message parts on delivery.
   * Additive and optional: old checkpoints parse unchanged.
   */
  cues: z.array(CueSchema).optional(),
  /** Evidence-derived response surfaces, persisted so retries render identically. */
  responseCards: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type PendingFinal = z.infer<typeof PendingFinalSchema>;

const RecallSourceSchema = z.object({
  date: z.string(),
  label: z.string(),
  kind: z.enum(['chat', 'knowledge_graph', 'decision', 'commitment']).optional(),
  hops: z.union([z.literal(1), z.literal(2)]).optional(),
  surfaceKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sourceRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  relevance: z.number().min(0).max(1).optional(),
  evidence: z
    .object({
      representation: z.enum(['summary_with_excerpt', 'message_excerpts']),
      sourceMessageIds: z.array(z.string().min(1)).max(100),
      renderedUtf8Bytes: z.number().int().nonnegative(),
    })
    .optional(),
});

export const TaskStateSchema = z.object({
  phase: z.string().default('start'),
  step: z.number().int().default(0),
  /** Owner timezone captured on the first leased run for relative schedule resolution. */
  requestTimeZone: z.string().min(1).max(100).optional(),
  completedToolCallIds: z.array(z.string()).default([]),
  /** One model step can propose several approval-gated calls — all park together. */
  pendingApprovals: z.array(PendingApprovalSchema).default([]),
  /** Model-emitted calls are checkpointed in order before any dispatch begins. */
  pendingToolBatch: PendingToolBatchSchema.nullish(),
  /** An in-flight browser job this task is waiting on. */
  pendingJob: PendingJobSchema.nullish(),
  /** Durable final-channel delivery checkpoint. */
  pendingFinal: PendingFinalSchema.nullish(),
  /** External/tool content has entered the model context; privileged calls are constrained. */
  untrustedContext: z.boolean().default(false),
  /** Earlier discussions auto-recall drew on this turn, for the chat UI affordance (Phase 4). */
  recall: z.array(RecallSourceSchema).nullish(),
  plannerState: z.record(z.string(), z.unknown()).default({}),
  /** Provenance-backed answer to the immediately preceding unresolved clarification. */
  clarificationContinuation: ClarificationContinuationSchema.optional(),
  scratchpad: z.string().default(''),
  /** Stable receipt for one completed skill-reflection decision on this task. */
  skillReflectionReceipt: z
    .object({
      status: z.enum([
        'created',
        'revised',
        'no_skill',
        'superseded',
        'owner_authored',
        'capacity',
        'already_processed',
        'ineligible',
      ]),
      author: z.literal('reflection'),
      skillId: z.string().nullish(),
      libraryRevision: z.string(),
      recordedAt: z.string(),
    })
    .optional(),
  /** Owner-requested compound outcomes; status comes only from durable receipts. */
  requestChecklist: RequestChecklistSchema.optional(),
  checklistRecoveryAttempts: z.number().int().min(0).max(1).default(0),
  /** One persisted, target-grounded attempt to recover a missing future watch. */
  futureWatchRecoveryAttempts: z.number().int().min(0).max(1).default(0),
  contextWindow: z.array(z.record(z.string(), z.unknown())).default([]),
  /**
   * High-water mark (ISO) for owner messages already folded into the window.
   * On resume from a park, owner chat messages newer than this are appended so a
   * correction typed while the task was parked is not stranded in a separate
   * task. Nullish: old checkpoints simply have no watermark and none is applied.
   */
  seenConversationAt: z.string().nullish(),
  /** Stable tie-breaker when multiple owner messages share the same timestamp. */
  seenConversationId: z.string().nullish(),
  /**
   * Loop-health counters for the response_checks record written at finalize:
   * steps served by a fallback model, and forced retries after a step that was
   * required to act returned no tool call. Checkpointed so parks don't reset
   * them.
   */
  degradedSteps: z.number().int().default(0),
  mustActRetries: z.number().int().default(0),
  /** One durable retry when a conceptual answer contains only a forbidden call. */
  conceptualAnswerRetried: z.boolean().optional(),
  /** Skills whose advice was injected, so finalize can record their outcome. */
  usedSkillIds: z.array(z.string()).default([]),
});
export type TaskState = z.infer<typeof TaskStateSchema>;
