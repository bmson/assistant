import { createHash } from 'node:crypto';
import type { TaskRow } from '@assistant/db';
import { createPostgresExecutionPersistence } from '@assistant/db';
import type { ExecutionContextRepository } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { BudgetReservationError } from '../cost.js';
import { isForwardedIngest } from '../email-provenance.js';
import type { TaskState, Trust } from '../events.js';
import { withSpan } from '../otel.js';
import { classifyFailure, failureNotice, ownerTaskLabel } from '../owner-text.js';
import {
  publicActivityFollowupDisposition,
  publicActivityScopeHash,
  type ResolvedReadIntent,
  resolveActiveReadIntent,
  type VerifiedOwnerReadTurn,
} from './active-read-intent.js';
import { requestedArtifactIntent } from './artifact-intent.js';
import {
  projectChecklistCancellationResume,
  projectChecklistCorrectionResume,
  taskBoundCorrectionReadRequest,
} from './checklist-correction-resume.js';
import { isKnownSenderReplyTask } from './executor/context-helpers.js';
import { refreshResumedConversationSearch } from './executor/conversation-search-refresh.js';
import { finalizePendingResponse, stageFinalResponse } from './executor/finalize.js';
import { unreadSharedDocumentIntent } from './executor/intent.js';
import {
  isBackgroundTask,
  noticeParts,
  notifyAttention,
  postConversationNotice,
  taskBudgetPermissionRequest,
} from './executor/notices.js';
import {
  type RunContext,
  resumePendingApprovals,
  resumePendingJob,
  runCodeJobPhase,
  runDirectDocumentRead,
  runMissionPhase,
  runPlanPhase,
} from './executor/phases.js';
import { foldOwnerRepliesSincePark, seedContextWithEvidence } from './executor/seed.js';
import { runStepLoop } from './executor/step-loop.js';
import { createToolContext } from './executor/tool-context.js';
import {
  type ExecuteResult,
  type ExecutorDeps,
  LOST_LEASE,
  type ToolContextLike,
} from './executor/types.js';
import { compact, latestUserText, toolResultMessage } from './executor/util.js';
import {
  checkpointTask,
  claimTask,
  completeTask,
  markTaskNeedsAttention,
  parkForBudget,
  recordFailedAttempt,
  sleepTask,
  type TaskLease,
  taskState,
} from './machine.js';
import {
  extractOwnerIntent,
  latestOwnerIntent,
  ownerAuthoredReadWindow,
  ownerAuthoredWindow,
  ownerIntentForResolvedRead,
} from './owner-intent.js';
import {
  buildRequestChecklist,
  hasOwnerChecklistCancellationMarker,
  ownerCancellationAuditIsConsistent,
} from './request-checklist.js';
import { RequestChecklistSchema } from './request-checklist-schema.js';
import { isSaveStatusQuestion, previousSaveStatus } from './saved-work.js';

/** Resolve only actual owner rows from this admitted chat; prompt history is not provenance. */
async function admittedReadIntent(
  repository: ExecutionContextRepository,
  task: TaskRow,
  window: ModelMessage[],
  timeZone: string,
): Promise<ResolvedReadIntent> {
  if (
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    !task.conversationId ||
    isForwardedIngest(task)
  )
    return { kind: 'none' };
  const trigger = task.trigger as {
    source?: unknown;
    agentId?: unknown;
    conversationId?: unknown;
    trust?: unknown;
    payload?: { text?: unknown; triggerMessageId?: unknown };
  } | null;
  const text = typeof trigger?.payload?.text === 'string' ? trigger.payload.text : '';
  const admittedOwnerIntent = extractOwnerIntent({ text, trust: 'owner' });
  const ownerText = admittedOwnerIntent.ownerAuthoredText;
  const unavailable = () =>
    resolveActiveReadIntent({ text: ownerText, now: task.createdAt, timeZone });
  if (
    trigger?.source !== 'chat' ||
    trigger.agentId !== task.agentId ||
    trigger.conversationId !== task.conversationId ||
    trigger.trust !== 'owner' ||
    typeof trigger.payload?.triggerMessageId !== 'string'
  )
    return unavailable();
  try {
    const current = await repository.getOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
      messageId: trigger.payload.triggerMessageId,
    });
    if (
      current?.role !== 'user' ||
      current.origin !== 'owner' ||
      current.conversationId !== task.conversationId ||
      current.taskId !== task.id ||
      current.text !== text
    )
      return unavailable();
    const rows = await repository.seedHistory({
      agentId: task.agentId,
      conversationId: task.conversationId,
      before: task.createdAt,
      throughMessageId: current.id,
      limit: 40,
    });
    const ownerRows = rows
      .filter(
        (row) =>
          row.role === 'user' &&
          row.origin === 'owner' &&
          row.conversationId === task.conversationId &&
          row.hiddenAt === null,
      )
      .slice(-8);
    const turns: VerifiedOwnerReadTurn[] = await Promise.all(
      ownerRows.map(async (row) => {
        const parent =
          row.taskId === task.id
            ? task
            : row.taskId
              ? await repository.getTask(task.agentId, row.taskId)
              : null;
        const parentTrigger = parent?.trigger as typeof trigger;
        const requestAt =
          parent?.agentId === task.agentId &&
          parent.conversationId === task.conversationId &&
          parent.type === 'chat_turn' &&
          parent.trust === 'owner' &&
          parentTrigger?.source === 'chat' &&
          parentTrigger.payload?.triggerMessageId === row.id &&
          parentTrigger.payload.text === row.text
            ? parent.createdAt
            : undefined;
        return {
          id: row.id,
          agentId: task.agentId,
          conversationId: task.conversationId as string,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          role: 'user',
          origin: 'owner',
          text: row.text,
          ownerAuthoredText: extractOwnerIntent({ text: row.text, trust: 'owner' })
            .ownerAuthoredText,
          ...(requestAt ? { requestAt } : {}),
        };
      }),
    );
    return resolveActiveReadIntent({
      text: ownerText,
      now: task.createdAt,
      timeZone,
      provenance: {
        agentId: task.agentId,
        conversationId: task.conversationId,
        taskId: task.id,
        triggerMessageId: current.id,
        requestHash: createHash('sha256').update(text).digest('hex'),
      },
      ownerTurns: turns,
      personalHistory: ownerAuthoredReadWindow(window, admittedOwnerIntent),
    });
  } catch {
    // Missing provenance must not turn an explicit public correction into a private lookup.
    return unavailable();
  }
}

/**
 * Why a goal says its queued work should no longer run: the owner stopped it, or
 * archived it out of the daily view. Null for every other case — including a
 * *paused* goal, because pausing only stops new automatic sessions and work
 * already in flight is still expected to finish. A goal that no longer exists
 * does not block either; the task is judged on its own terms.
 */
export function goalStopReason(
  goal: { status: string; archivedAt: Date | null } | undefined,
): 'stopped' | 'archived' | null {
  if (!goal) return null;
  if (goal.status === 'abandoned') return 'stopped';
  if (goal.archivedAt) return 'archived';
  return null;
}

async function abandonedGoalFor(
  repository: ExecutionContextRepository,
  task: TaskRow,
): Promise<'stopped' | 'archived' | null> {
  if (!task.goalId) return null;
  return goalStopReason(
    (await repository.getGoalStopState(task.agentId, task.goalId)) ?? undefined,
  );
}

export { roleForTask } from './executor/role.js';
// Public API preserved: these symbols now live in ./executor/* modules but stay
// importable from './workflow/executor.js' (and thus '@assistant/core').
export type {
  DispatcherPort,
  ExecuteResult,
  ExecutorDeps,
  ToolContextLike,
} from './executor/types.js';
export { replaceToolResultMessage, toolResultMessage } from './executor/util.js';

/**
 * The workflow executor: claim → load checkpoint → (plan) → step loop
 * (model proposes tools → risk gate dispatches) → checkpoint each step →
 * park / sleep / complete. Resume is *load state, continue* — never replay.
 */
export async function executeTask(
  deps: ExecutorDeps,
  taskId: string,
  generation?: number,
): Promise<ExecuteResult> {
  const { db } = deps;
  const persistence = deps.persistence ?? createPostgresExecutionPersistence(db);
  deps = { ...deps, persistence };
  const task = await claimTask(persistence.tasks, taskId, generation);
  if (!task) return { outcome: 'not_claimable' };

  // The owner stopping or archiving a goal must also stop work already sitting
  // in the queue for it. Cancelling at the source is racy on its own — a task
  // can be claimed between the owner's click and the cancelling write — so the
  // executor refuses the run itself. Spending against an abandoned goal is the
  // failure this closes.
  const abandoned = await abandonedGoalFor(persistence.executionContext, task);
  if (abandoned) {
    await completeTask(persistence.tasks, task, {
      status: 'cancelled',
      progress: `stopped because its goal was ${abandoned}`,
    });
    return { outcome: 'cancelled', detail: `goal ${abandoned}` };
  }

  return withSpan('task.execute', { taskId, type: task.type, attempt: task.attempt }, async () => {
    try {
      return await runSteps(deps, task);
    } catch (err) {
      if (err instanceof BudgetReservationError) {
        if (err.message.startsWith('task budget')) {
          const marked = await markTaskNeedsAttention(
            persistence.tasks,
            task,
            `budget: ${err.message}`,
          );
          if (!marked) return LOST_LEASE;
          const budgetRequest = taskBudgetPermissionRequest(task, err.message);
          await notifyAttention(deps, task, budgetRequest.text, [budgetRequest.part]);
          return { outcome: 'needs_attention', detail: err.message.slice(0, 500) };
        }
        const fresh = await persistence.executionContext.getTask(task.agentId, task.id);
        const parked = await parkForBudget(
          persistence.tasks,
          task,
          taskState(fresh ?? task),
          err.resumeAt,
        );
        if (!parked) return LOST_LEASE;
        await postConversationNotice(
          persistence.messages,
          task,
          `I'm pausing here — ${err.message}. This resumes automatically when the budget resets.`,
          noticeParts('parked'),
        );
        return { outcome: 'parked', detail: err.message.slice(0, 500) };
      }
      const disposition = await recordFailedAttempt(persistence.tasks, task, String(err));
      if (disposition === 'lost_lease') return LOST_LEASE;
      if (disposition === 'dead_letter') {
        // Retry budget exhausted: the task is now needs_attention and will not
        // self-resume. Every other terminal/park branch notifies the owner, so
        // this one must too — otherwise the request dies silently in its thread.
        // notifyAttention stamps the row so the re-notify sweep won't repeat it,
        // and leaves it unstamped (sweep-eligible) if this notify itself failed.
        // The raw error is on the task row, where Activity shows it. What goes
        // to a person is one plain line — never a stack, a provider's JSON or a
        // billing URL. Background work names itself in the Notifications log.
        const label = ownerTaskLabel(task.title);
        await notifyAttention(
          deps,
          task,
          isBackgroundTask(task)
            ? `${label ? `${label} didn't finish` : "A background task didn't finish"}. ${failureNotice(
                err,
              )
                .replace(/^I couldn't finish that — /u, '')
                .replace(/^./u, (c) => c.toUpperCase())}`
            : failureNotice(err),
          [],
          // A provider outage reads as "Response interrupted — try again", not
          // as a question waiting on the owner.
          classifyFailure(err) === 'provider' ? 'provider-failed' : 'needs-attention',
        );
      }
      return {
        outcome: disposition === 'dead_letter' ? 'dead_letter' : 'failed',
        detail: String(err).slice(0, 500),
      };
    }
  });
}

/**
 * Does this task start with externally controlled content in its context?
 *
 * Any non-privileged sender does. Email additionally carries the presumption
 * even from the owner, because forwarded threads and quoted replies are exactly
 * how attacker-controlled text gets inside an authenticated message — that is
 * the provenance boundary the taint gate exists to hold.
 *
 * The presumption is dropped in one case only: a DKIM-verified owner sender
 * (see classifySender — owner trust is unreachable without aligned
 * SPF/DKIM/DMARC) whose body ingestion positively determined carries no forward
 * separator and no quoted block. Every word is then the owner's own, which is
 * no more untrusted than the same words typed into the web chat — a channel
 * that is never tainted. Treating those differently was an unjustified
 * asymmetry that cost the owner an approval on requests they typed themselves.
 *
 * Everything else stays tainted, including a `quotesExternalContent` flag that
 * is absent (tasks enqueued before the check existed) or non-boolean. Only an
 * explicit `false` relaxes anything.
 */
export function shouldTaintContext(task: Pick<TaskRow, 'trust' | 'trigger'>): boolean {
  if (task.trust === 'known' || task.trust === 'unknown') return true;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { quotesExternalContent?: unknown; taintedOrigin?: unknown };
  } | null;
  // A task scheduled from a tainted session carries its provenance forward
  // (task.schedule stamps taintedOrigin). Without this a laundered instruction
  // would run in a clean context with autonomous network egress.
  if (trigger?.payload?.taintedOrigin === true) return true;
  if (trigger?.source !== 'email') return false;
  const ownerAuthored = task.trust === 'owner' && trigger.payload?.quotesExternalContent === false;
  return !ownerAuthored;
}

async function checklistCancellationOwnersAreValid(
  repository: ExecutionContextRepository,
  task: TaskRow,
  value: unknown,
): Promise<string | undefined> {
  const parsed = RequestChecklistSchema.safeParse(value);
  if (!parsed.success) return 'malformed-checklist';
  const checklist = parsed.data;
  if (!ownerCancellationAuditIsConsistent(checklist)) return 'inconsistent-cancellation-audit';
  const audit = checklist.cancellationAudit ?? [];
  if (audit.length === 0) return undefined;
  const trigger = task.trigger as {
    source?: unknown;
    agentId?: unknown;
    conversationId?: unknown;
    trust?: unknown;
    payload?: { text?: unknown; triggerMessageId?: unknown };
  } | null;
  if (
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    !task.conversationId ||
    trigger?.source !== 'chat' ||
    trigger.agentId !== task.agentId ||
    trigger.conversationId !== task.conversationId ||
    trigger.trust !== 'owner' ||
    trigger.payload?.text !== checklist.request ||
    typeof trigger.payload.triggerMessageId !== 'string'
  )
    return 'unsupported-cancellation-task';
  const request = await repository.getOwnerMessage({
    agentId: task.agentId,
    conversationId: task.conversationId,
    messageId: trigger.payload.triggerMessageId,
  });
  if (
    !request ||
    request.taskId !== task.id ||
    request.role !== 'user' ||
    request.origin !== 'owner' ||
    request.text !== checklist.request
  )
    return 'original-owner-message-unverified';
  for (const entry of audit) {
    if (
      entry.taskId !== task.id ||
      entry.conversationId !== task.conversationId ||
      entry.ownerTaskId !== task.id
    )
      return 'cancellation-audit-task-mismatch';
    const message = await repository.getOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
      messageId: entry.ownerMessageId,
    });
    const ownerMessageBindingValid = entry.requestHash
      ? entry.requestHash ===
        createHash('sha256')
          .update(JSON.stringify(['owner-checklist-cancellation-v1', message?.text ?? '']))
          .digest('hex')
      : Boolean(message && entry.requestSpans.every((span) => message.text.includes(span)));
    if (
      !message ||
      message.id !== entry.ownerMessageId ||
      message.taskId !== task.id ||
      message.role !== 'user' ||
      message.origin !== 'owner' ||
      !ownerMessageBindingValid
    )
      return 'cancellation-owner-message-unverified';
  }
  const lastAction = checklist.lastOwnerAction;
  const expectedLatestOwnerMessageId =
    lastAction?.kind === 'replace'
      ? checklist.revisionAudit?.at(-1)?.ownerMessageId
      : audit.at(-1)?.ownerMessageId;
  if (!expectedLatestOwnerMessageId) return 'latest-owner-action-unverified';
  const latestOwner = await repository.getLatestOwnerMessage({
    agentId: task.agentId,
    conversationId: task.conversationId,
  });
  if (latestOwner?.id !== expectedLatestOwnerMessageId) return 'cancellation-owner-head-changed';
  return undefined;
}

async function runSteps(deps: ExecutorDeps, task: TaskLease): Promise<ExecuteResult> {
  const { db, router, dispatcher } = deps;
  const persistence = deps.persistence ?? createPostgresExecutionPersistence(db);
  const lease = task;
  const state = taskState(task);
  const rawChecklist = (state as { requestChecklist?: Record<string, unknown> }).requestChecklist;
  const lastOwnerAction = rawChecklist?.lastOwnerAction as { kind?: unknown } | undefined;
  let hasChecklistCancellation = lastOwnerAction?.kind === 'cancel';
  const hasChecklistCorrection = Boolean(
    rawChecklist &&
      !hasChecklistCancellation &&
      (lastOwnerAction?.kind === 'replace' ||
        (!lastOwnerAction &&
          (Object.hasOwn(rawChecklist, 'revision') ||
            Object.hasOwn(rawChecklist, 'revisionAudit')))),
  );

  const trigger = task.trigger as {
    source?: unknown;
    externalEventId?: unknown;
    payload?: Record<string, unknown>;
  } | null;
  if (trigger?.payload?.kind === 'arrival') {
    const observationId = trigger.payload.arrivalObservationId;
    const validTask =
      task.trust === 'assistant' &&
      task.type === 'adhoc' &&
      !task.conversationId &&
      !task.parentTaskId &&
      trigger.source === 'internal' &&
      typeof trigger.externalEventId === 'string' &&
      new RegExp(`^arrival:${task.agentId}:\\d{4}-\\d{2}-\\d{2}$`).test(trigger.externalEventId);
    const active =
      validTask &&
      typeof observationId === 'string' &&
      Boolean(deps.isArrivalObservationActive) &&
      (await deps.isArrivalObservationActive?.(task.agentId, observationId));
    if (!active) {
      const cancelled = await completeTask(persistence.tasks, lease, {
        status: 'cancelled',
        progress: 'arrival observation expired or invalid; no location details used',
      });
      if (!cancelled) return LOST_LEASE;
      return { outcome: 'cancelled', detail: 'arrival observation expired or invalid' };
    }
    if (state.pendingFinal) return finalizePendingResponse(deps, lease, state.pendingFinal, state);
    const safeText = 'You’ve arrived. Would you like a hand with anything?';
    const window = [{ role: 'user' as const, content: 'Owner-approved generic arrival nudge.' }];
    return stageFinalResponse(deps, lease, state, window, {
      text: safeText,
      progress: 'Sent the owner-approved generic arrival nudge.',
      terminalStatus: 'done',
      outcome: 'done',
      contractBlocked: false,
    });
  }
  if (state.pendingFinal && !hasChecklistCorrection) {
    // A cancellation-bound final is scoped to the owner message that selected
    // the retained work. A delivery retry must not publish that saved answer
    // after a newer owner message has changed the conversation context.
    if (hasOwnerChecklistCancellationMarker(state.requestChecklist)) {
      const cancellationIssue = await checklistCancellationOwnersAreValid(
        persistence.executionContext,
        task,
        state.requestChecklist,
      );
      if (cancellationIssue) {
        const marked = await markTaskNeedsAttention(
          persistence.tasks,
          lease,
          'saved cancellation reply could not be delivered because its owner context changed',
        );
        return marked
          ? { outcome: 'needs_attention', detail: 'saved cancellation reply requires review' }
          : LOST_LEASE;
      }
    }
    return finalizePendingResponse(deps, lease, state.pendingFinal, state);
  }

  if (shouldTaintContext(task)) {
    state.untrustedContext = true;
  }

  const agent = await persistence.executionContext.getAgent(task.agentId);
  if (!agent) throw new Error('Task agent does not exist');
  if (!state.requestTimeZone) {
    state.requestTimeZone = agent.timezone;
    if (!(await checkpointTask(persistence.tasks, lease, state, { preserveFailureCounters: true })))
      return LOST_LEASE;
  }
  const abort = new AbortController();

  let correction: ReturnType<typeof projectChecklistCorrectionResume>;
  let cancellation: ReturnType<typeof projectChecklistCancellationResume>;
  let cancellationOriginalIntent: ReturnType<typeof latestOwnerIntent> | undefined;
  let correctionOwnerMessage: Awaited<ReturnType<ExecutionContextRepository['getOwnerMessage']>> =
    null;
  let originalCorrectionIntent: ReturnType<typeof latestOwnerIntent> | undefined;
  if (hasChecklistCorrection) {
    const trigger = task.trigger as {
      source?: unknown;
      payload?: { text?: unknown; triggerMessageId?: unknown };
    } | null;
    const checklist = state.requestChecklist;
    const payloadText = trigger?.payload?.text;
    const triggerMessageId = trigger?.payload?.triggerMessageId;
    const audit = checklist?.revisionAudit;
    const correctionMessageId = audit?.at(-1)?.ownerMessageId;
    const rejectCorrection = async (reason: string): Promise<ExecuteResult> =>
      withSpan(
        'task.checklist_correction.refused',
        { taskId: task.id, reason: reason.slice(0, 180) },
        async () => {
          const text = 'I couldn’t complete this lookup. Review it in Activity to continue.';
          return stageFinalResponse(
            deps,
            lease,
            state,
            state.contextWindow as unknown as ModelMessage[],
            {
              text,
              progress: 'lookup paused for review',
              terminalStatus: 'needs_attention',
              outcome: 'needs_attention',
              contractNotice: true,
            },
          );
        },
      );
    if (
      task.type !== 'chat_turn' ||
      task.trust !== 'owner' ||
      task.goalId !== null ||
      !task.conversationId ||
      trigger?.source !== 'chat' ||
      isForwardedIngest(task) ||
      typeof payloadText !== 'string' ||
      !payloadText.trim() ||
      typeof triggerMessageId !== 'string' ||
      !checklist ||
      !correctionMessageId ||
      state.pendingJob ||
      state.pendingApprovals.length > 0
    )
      return rejectCorrection('the task is not a clean, directly admitted owner chat lookup');

    const triggerMessage = await persistence.executionContext.getOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
      messageId: triggerMessageId,
    });
    correctionOwnerMessage = await persistence.executionContext.getOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
      messageId: correctionMessageId,
    });
    const latestOwnerMessage = await persistence.executionContext.getLatestOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
    });
    if (
      !triggerMessage ||
      triggerMessage.taskId !== task.id ||
      triggerMessage.text !== payloadText ||
      payloadText.trim() !== checklist.request.trim() ||
      !correctionOwnerMessage ||
      correctionOwnerMessage.taskId !== task.id ||
      latestOwnerMessage?.id !== correctionMessageId
    )
      return rejectCorrection(
        'the original request or latest correction no longer matches its durable owner message',
      );

    originalCorrectionIntent = latestOwnerIntent([{ role: 'user', content: payloadText }], {
      trust: task.trust as Trust,
      trigger: task.trigger,
    });
    const correctionRead = taskBoundCorrectionReadRequest(correctionOwnerMessage.text, {
      now: correctionOwnerMessage.createdAt,
      timeZone: state.requestTimeZone ?? agent.timezone,
      authorizedScopes: originalCorrectionIntent.authorizedScopes,
    });
    if (
      originalCorrectionIntent.sourceActor !== 'owner' ||
      originalCorrectionIntent.requestKind !== 'new_request' ||
      originalCorrectionIntent.separation !== 'none' ||
      !originalCorrectionIntent.authorizedScopes.includes('private_read') ||
      !correctionRead
    )
      return rejectCorrection(
        'the correction is not a direct owner-authored private lookup within the original request scope',
      );

    correction = projectChecklistCorrectionResume({
      task: { id: task.id, agentId: task.agentId, conversationId: task.conversationId },
      checklist,
      ownerMessage: {
        id: correctionOwnerMessage.id,
        taskId: correctionOwnerMessage.taskId ?? '',
        agentId: task.agentId,
        conversationId: task.conversationId,
        role: 'user',
        origin: 'owner',
        text: correctionOwnerMessage.text,
        createdAt: correctionOwnerMessage.createdAt,
      },
      latestConversationOwnerMessageId: latestOwnerMessage.id,
      originalIntent: originalCorrectionIntent,
      clarificationContinuation: state.clarificationContinuation,
    });
    if (!correction)
      return rejectCorrection(
        'the selected checklist item, revision audit, clarification, or owner-message binding is inconsistent',
      );
    if (
      correction.activeOutcomes.length === 0 &&
      correction.excludedOutcomeIds.length !== checklist.items.length
    )
      return rejectCorrection(
        'the revised checklist has no verifiable active or completed outcomes',
      );
    const referenceAtByItem = new Map<string, Date>();
    for (const outcome of correction.activeOutcomes) {
      const priorAudit = (checklist.revisionAudit ?? [])
        .filter((entry) => entry.itemId === outcome.id)
        .at(-1);
      if (!priorAudit) {
        referenceAtByItem.set(outcome.id, task.createdAt);
        continue;
      }
      const referenceMessage = await persistence.executionContext.getOwnerMessage({
        agentId: task.agentId,
        conversationId: task.conversationId,
        messageId: priorAudit.ownerMessageId,
      });
      const normalizedText = referenceMessage?.text
        .trim()
        .replace(/[.!?]+$/, '')
        .trim();
      const normalizedLabel = priorAudit.toLabel
        .trim()
        .replace(/[.!?]+$/, '')
        .trim();
      if (
        !referenceMessage ||
        referenceMessage.taskId !== task.id ||
        referenceMessage.conversationId !== task.conversationId ||
        referenceMessage.role !== 'user' ||
        referenceMessage.origin !== 'owner' ||
        normalizedText !== normalizedLabel ||
        !(referenceMessage.createdAt instanceof Date) ||
        !Number.isFinite(referenceMessage.createdAt.getTime())
      )
        return rejectCorrection(
          'an earlier corrected lookup has no exact durable owner-message time anchor',
        );
      referenceAtByItem.set(outcome.id, referenceMessage.createdAt);
    }
    correction = {
      ...correction,
      activeOutcomes: correction.activeOutcomes.map((outcome) => ({
        ...outcome,
        referenceAt: referenceAtByItem.get(outcome.id),
      })),
    };
    // Keep completed siblings in the corrected answer only when their current
    // evidence is still bound to the unchanged item or that item's latest audit.
    const correctionEvidence = await persistence.executionEvidence.taskEvidence({
      agentId: task.agentId,
      taskId: task.id,
    });
    const completedOutcomes: typeof correction.completedOutcomes = [];
    for (const item of checklist.items.filter((candidate) => candidate.status === 'completed')) {
      const itemAudits = (checklist.revisionAudit ?? []).filter(
        (entry) => entry.itemId === item.id,
      );
      const latestItemAudit = itemAudits.at(-1);
      const supersededEvidenceIds = new Set(
        itemAudits.flatMap((entry) => entry.excludedEvidenceIds),
      );
      const itemEvidenceIsBound =
        item.evidence.length > 0 &&
        new Set(item.evidence.map((entry) => entry.id)).size === item.evidence.length &&
        item.evidence.every((entry) => {
          if (supersededEvidenceIds.has(entry.id)) return false;
          const row = correctionEvidence.find((candidate) => candidate.id === entry.id);
          if (row?.status !== 'succeeded') return false;
          if (!latestItemAudit) return true;
          const decision =
            row.decision && typeof row.decision === 'object'
              ? (
                  row.decision as {
                    checklistCorrection?: {
                      revision?: unknown;
                      outcomeId?: unknown;
                      ownerMessageId?: unknown;
                    };
                  }
                ).checklistCorrection
              : undefined;
          return (
            latestItemAudit.toLabel === item.label &&
            JSON.stringify(latestItemAudit.toTargetTerms) === JSON.stringify(item.targetTerms) &&
            decision?.revision === latestItemAudit.revision &&
            decision.outcomeId === item.id &&
            decision.ownerMessageId === latestItemAudit.ownerMessageId
          );
        });
      if (!itemEvidenceIsBound)
        return rejectCorrection('a completed checklist item has no current successful receipt');
      completedOutcomes.push({
        id: item.id,
        label: item.label,
        ...((item as { detail?: string }).detail
          ? { detail: (item as { detail?: string }).detail }
          : {}),
      });
    }
    correction = {
      ...correction,
      completedOutcomes,
    };
    if (
      correction.activeOutcomes.some(
        (item) =>
          item.kind !== 'lookup' ||
          !taskBoundCorrectionReadRequest(item.label, {
            now: item.referenceAt ?? task.createdAt,
            timeZone: state.requestTimeZone ?? agent.timezone,
            authorizedScopes: originalCorrectionIntent?.authorizedScopes ?? [],
          }),
      )
    ) {
      return rejectCorrection('the correction task contains a mixed or unsupported action outcome');
    }

    if (state.pendingFinal) {
      const savedBinding = state.pendingFinal.checklistCorrection;
      const outcomeIds = new Set(
        [...correction.completedOutcomes, ...correction.activeOutcomes].map(
          (outcome) => outcome.id,
        ),
      );
      const currentBindings = checklist.items
        .filter((item) => outcomeIds.has(item.id))
        .map((item) => ({
          id: item.id,
          status: item.status,
          evidenceIds:
            item.status === 'completed'
              ? item.evidence
                  .map((entry) => entry.id)
                  .slice(-256)
                  .sort()
              : [],
        }));
      const sameStrings = (left: string[], right: string[]) =>
        left.length === right.length && left.every((value, index) => value === right[index]);
      const bindingMatches =
        savedBinding?.revision === correction.revision &&
        savedBinding.ownerMessageId === correction.ownerMessageId &&
        new Set(savedBinding.outcomes.map((outcome) => outcome.id)).size ===
          savedBinding.outcomes.length &&
        savedBinding.outcomes.length === currentBindings.length &&
        currentBindings.every((current, index) => {
          const saved = savedBinding.outcomes[index];
          return (
            current !== undefined &&
            saved !== undefined &&
            (current.status === 'completed' || current.status === 'blocked') &&
            current.id === saved.id &&
            current.status === saved.status &&
            new Set(current.evidenceIds).size === current.evidenceIds.length &&
            new Set(saved.evidenceIds).size === saved.evidenceIds.length &&
            sameStrings(current.evidenceIds, [...saved.evidenceIds].sort())
          );
        });
      const hasBlockedOutcome = currentBindings.some((outcome) => outcome.status === 'blocked');
      const deliveryRetryIsBounded =
        state.pendingFinal.deliveryNeedsAttention === true &&
        state.pendingFinal.finalDelivery?.legs.some((leg) => leg.status === 'rejected') === true &&
        state.pendingFinal.finalDelivery?.legs.some((leg) => leg.status === 'unknown') !== true;
      const finalStatusMatchesChecklist = hasBlockedOutcome
        ? state.pendingFinal.terminalStatus === 'needs_attention' &&
          state.pendingFinal.outcome === 'needs_attention' &&
          (!state.pendingFinal.deliveryNeedsAttention || deliveryRetryIsBounded)
        : (state.pendingFinal.terminalStatus === 'done' &&
            state.pendingFinal.outcome === 'done' &&
            !state.pendingFinal.deliveryNeedsAttention) ||
          (state.pendingFinal.terminalStatus === 'needs_attention' &&
            state.pendingFinal.outcome === 'needs_attention' &&
            deliveryRetryIsBounded);
      const rows = await persistence.executionEvidence.taskEvidence({
        agentId: task.agentId,
        taskId: task.id,
      });
      const evidenceMatches = Boolean(
        savedBinding &&
          bindingMatches &&
          finalStatusMatchesChecklist &&
          savedBinding.outcomes.every((outcome) => {
            const item = checklist.items.find((candidate) => candidate.id === outcome.id);
            const latestItemAudit = (checklist.revisionAudit ?? [])
              .filter((entry) => entry.itemId === outcome.id)
              .at(-1);
            if (!item || (outcome.status === 'completed' && outcome.evidenceIds.length === 0))
              return false;
            return outcome.evidenceIds.every((id) => {
              const row = rows.find((candidate) => candidate.id === id);
              if (!row) return false;
              const decision =
                row.decision && typeof row.decision === 'object'
                  ? (
                      row.decision as {
                        checklistCorrection?: {
                          revision?: unknown;
                          outcomeId?: unknown;
                          ownerMessageId?: unknown;
                        };
                      }
                    ).checklistCorrection
                  : undefined;
              return (
                row.status === 'succeeded' &&
                (!latestItemAudit ||
                  (decision?.revision === latestItemAudit.revision &&
                    decision.outcomeId === outcome.id &&
                    decision.ownerMessageId === latestItemAudit.ownerMessageId))
              );
            });
          }),
      );
      if (!evidenceMatches) {
        const marked = await markTaskNeedsAttention(
          persistence.tasks,
          lease,
          'saved corrected reply could not be verified; no new lookup was run',
        );
        return marked
          ? { outcome: 'needs_attention', detail: 'saved corrected reply could not be verified' }
          : LOST_LEASE;
      }
      return finalizePendingResponse(deps, lease, state.pendingFinal, state);
    }

    // A correction gets its own bounded, task-local context. Keep original
    // authority in ctx.ownerIntent; omit stale model prose, plans and receipts.
    state.contextWindow = [
      {
        role: 'system',
        content: `Resume only task ${task.id}, checklist revision ${correction.revision}. Original owner request scope ceiling: ${checklist.request}. Active checklist outcomes: ${correction.activeOutcomes.map((item) => `${item.id}: ${item.label}`).join('; ') || 'none'}. Do not perform work outside those exact pending or blocked outcomes.`,
      },
      { role: 'user', content: correctionOwnerMessage.text },
    ] as unknown as TaskState['contextWindow'];
  }

  // Code jobs (nightly extraction/consolidation, imports) run a registered
  // function, and missions run a deadline/reflection wake — both instead of the
  // model step loop.
  const codeJobResult = await runCodeJobPhase(deps, lease);
  if (codeJobResult) return codeJobResult;
  const missionResult = await runMissionPhase(deps, lease, agent);
  if (missionResult) return missionResult;

  let window = state.contextWindow as unknown as ModelMessage[];
  if (window.length === 0) {
    const seeded = await seedContextWithEvidence(persistence.executionContext, task);
    window = seeded.messages;
    if (seeded.historicalEvidenceTainted) state.untrustedContext = true;
    if (seeded.clarificationContinuation) {
      state.clarificationContinuation = seeded.clarificationContinuation;
      if (seeded.clarificationContinuation.tainted) state.untrustedContext = true;
    }
    // Publish the seeded window into state BEFORE building the tool context, so
    // harvestKnownAddresses (which scans state.contextWindow) sees the thread's
    // real recipients on the FIRST run — not just on resume. Without this, the
    // recipient-provenance whitelist was empty on run 1, so a send to an address
    // named in the seeded thread flagged as unverified, yet the identical send on
    // a later resume (window now checkpointed) passed — same request, different
    // gating by run number.
    state.contextWindow = window as unknown as TaskState['contextWindow'];
  }
  // A direct document/sheet/slides request skips the generic planner, then forces
  // the matching creation tool. The D9 known-sender reply child is exempt: its
  // instruction embeds the sender's own draft, whose free text could otherwise
  // trip the artifact/doc-URL heuristics and force docs.create over gmail.send.
  const isKnownReply = isKnownSenderReplyTask(task);
  const resolvedReadIntent = await admittedReadIntent(
    persistence.executionContext,
    task,
    window,
    state.requestTimeZone ?? agent.timezone,
  );
  const publicOnly = resolvedReadIntent.kind === 'public_activity';
  if (resolvedReadIntent.kind === 'public_activity' || resolvedReadIntent.kind === 'combined') {
    // A validated, bounded data checkpoint only. The approval journal remains
    // the sole record of proposed arguments and permission to execute them.
    state.plannerState.publicActivityScope = resolvedReadIntent.public;
    state.plannerState.publicActivityScopeHash = publicActivityScopeHash(resolvedReadIntent.public);
  }
  if (resolvedReadIntent.kind === 'public_activity' || resolvedReadIntent.kind === 'combined') {
    // Rebuild public context from this task's admitted scope and current web
    // receipts. Earlier assistant prose, private tool results and recall are
    // never a source for a public discovery answer, including after a retry.
    const publicRows = await persistence.executionEvidence.taskEvidence({
      agentId: task.agentId,
      taskId: task.id,
    });
    const webMessages = publicRows
      .filter(
        (row) =>
          /^web\.(?:search|fetch)$/.test(row.toolName) ||
          (!publicOnly &&
            /^(?:calendar\.(?:list_events|search_events)|gmail\.(?:search|read_thread))$/.test(
              row.toolName,
            )),
      )
      .flatMap((row): ModelMessage[] => {
        const journal = state.pendingToolBatch?.calls.find((call) => call.dbToolCallId === row.id);
        const toolCallId = journal?.toolCallId ?? row.id;
        return [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId, toolName: row.toolName, input: row.args }],
          } as ModelMessage,
          toolResultMessage(
            toolCallId,
            row.toolName,
            row.status === 'succeeded' ? row.result : { status: row.status, error: row.error },
          ),
        ];
      });
    const scope = resolvedReadIntent.public;
    window = [
      {
        role: 'user',
        content: `Find ${scope.topic} in ${scope.location.label}, from ${scope.civilWindow.startDate} to before ${scope.civilWindow.endDateExclusive} (${scope.clock.timeZone}). ${scope.filters.map((filter) => filter.value).join('; ')}. Use public web sources only. Calendar, mail, recalled context and previous assistant answers are excluded. Return a compact shortlist with verified dates, place and source links; name any unverified coverage.`,
      },
      ...webMessages,
    ];
    state.contextWindow = window as unknown as TaskState['contextWindow'];
    state.recall = undefined;
  }
  const ownerIntent = ownerIntentForResolvedRead(
    correction && originalCorrectionIntent
      ? originalCorrectionIntent
      : latestOwnerIntent(window, {
          trust: task.trust as Trust,
          trigger: task.trigger,
          clarificationContinuation: state.clarificationContinuation,
        }),
    resolvedReadIntent,
  );
  const ownerWindow = ownerAuthoredWindow(window, ownerIntent);
  const artifactIntent =
    !correction && state.step === 0 && !isKnownReply
      ? requestedArtifactIntent(ownerIntent.ownerAuthoredText)
      : undefined;
  const documentReadIntent =
    !correction && state.step === 0 && !artifactIntent && !isKnownReply
      ? await unreadSharedDocumentIntent(persistence.executionEvidence, task, ownerWindow)
      : undefined;
  const browserStageSnapshots = new Map<
    string,
    {
      contextWindow: TaskState['contextWindow'];
      pendingJob: TaskState['pendingJob'];
      pendingToolBatch: TaskState['pendingToolBatch'];
    }
  >();

  // rc holds the shared, mutable run state. The browser-staging closure reads
  // the LIVE window through rc, so it is built after rc and the step loop can
  // reassign rc.window (compaction) without stale captures.
  const rc: RunContext = {
    deps,
    db,
    router,
    dispatcher,
    task,
    agent,
    state,
    ctx: undefined as unknown as ToolContextLike,
    window,
    resolvedReadIntent,
    artifactIntent,
    documentReadIntent,
    ...(correction ? { checklistCorrection: correction } : {}),
  };
  rc.ctx = createToolContext({
    db,
    executionJobs: persistence.executionJobs,
    task,
    state,
    requestTimeZone: state.requestTimeZone,
    persistence,
    signal: abort.signal,
    getWindow: () => rc.window,
    browserStageSnapshots,
  });
  rc.ctx.ownerIntent = ownerIntent;

  if (resolvedReadIntent.kind === 'clarify_public') {
    const text =
      resolvedReadIntent.reason === 'missing_location'
        ? 'Which city should I search for public events in?'
        : resolvedReadIntent.reason === 'missing_time'
          ? 'What date or date range should I search for public events?'
          : 'Please restate the city, dates and any requirements for the public events search so I can keep the search within your request.';
    return stageFinalResponse(deps, lease, state, rc.window, {
      text,
      progress: 'Public search needs clarification; no private lookup was substituted.',
      terminalStatus: 'done',
      outcome: 'done',
    });
  }

  rc.publicApprovalCurrent = async () => {
    if (resolvedReadIntent.kind !== 'public_activity' && resolvedReadIntent.kind !== 'combined')
      return true;
    try {
      const current = await persistence.executionContext.getOwnerMessage({
        agentId: task.agentId,
        conversationId: resolvedReadIntent.public.conversationId,
        messageId: resolvedReadIntent.public.requestMessageId,
      });
      if (
        !current ||
        current.taskId !== task.id ||
        current.origin !== 'owner' ||
        current.role !== 'user'
      )
        return false;
      // Anchor at the actual admitted message identity, including sub-ms DB
      // timestamps: read from one millisecond before, then locate the exact ID.
      // The parked latest-message watermark could already include a correction.
      const ordered = await persistence.executionContext.getOwnerRepliesAfter({
        agentId: task.agentId,
        conversationId: resolvedReadIntent.public.conversationId,
        after: { createdAt: new Date(current.createdAt.getTime() - 1) },
        limit: 10,
      });
      const index = ordered.findIndex((row) => row.id === current.id);
      if (index < 0 || ordered.length >= 10) return false;
      const newer = ordered.slice(index + 1);
      for (const reply of newer) {
        if (
          reply.role !== 'user' ||
          reply.origin !== 'owner' ||
          reply.hiddenAt != null ||
          reply.conversationId !== task.conversationId
        )
          return false;
        const parent = reply.taskId
          ? await persistence.executionContext.getTask(task.agentId, reply.taskId)
          : null;
        const next =
          parent && parent.agentId === task.agentId && parent.conversationId === task.conversationId
            ? await admittedReadIntent(
                persistence.executionContext,
                parent,
                [],
                state.requestTimeZone ?? agent.timezone,
              )
            : resolveActiveReadIntent({
                text: reply.text,
                now: reply.createdAt,
                timeZone: state.requestTimeZone ?? agent.timezone,
              });
        const disposition = publicActivityFollowupDisposition(
          resolvedReadIntent.public,
          next,
          reply.text,
          resolvedReadIntent,
        );
        if (disposition === 'superseded') return false;
        // A new substantive topic ends this search's conversational linkage.
        // A later unqualified Stop must not revoke every earlier task.
        if (disposition === 'unrelated') break;
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!(await rc.publicApprovalCurrent())) {
    const marked = await markTaskNeedsAttention(
      persistence.tasks,
      lease,
      'The public search changed or could not be verified; no further lookup was dispatched.',
    );
    return marked
      ? { outcome: 'needs_attention', detail: 'public search superseded or unverifiable' }
      : LOST_LEASE;
  }

  // ── Resume: settle a finished (or timed-out) browser job, then approvals ───
  if (!correction) await resumePendingJob(rc);
  const approvalsResult = correction ? null : await resumePendingApprovals(rc);
  if (approvalsResult) return approvalsResult;

  // A browser job is (still) in flight — sleep until its callback or timeout.
  if (state.pendingJob && !correction) {
    state.contextWindow = compact(rc.window) as unknown as TaskState['contextWindow'];
    const slept = await sleepTask(
      persistence.tasks,
      lease,
      state,
      new Date(state.pendingJob.timeoutAt),
    );
    if (!slept) return LOST_LEASE;
    return { outcome: 'sleeping', detail: 'browser job running' };
  }

  // Fold any owner correction typed while this task was parked into the window,
  // so a resumed task acts on the latest owner intent, not a stale checkpoint.
  // (First run just baselines the watermark; chat channel only.)
  if (
    !correction &&
    resolvedReadIntent.kind !== 'public_activity' &&
    resolvedReadIntent.kind !== 'combined' &&
    !(await foldOwnerRepliesSincePark(persistence.executionContext, task, state, rc.window))
  ) {
    const marked = await markTaskNeedsAttention(
      persistence.tasks,
      lease,
      'a recognized owner cancellation could not be recorded safely; no additional action was dispatched',
    );
    return marked
      ? { outcome: 'needs_attention', detail: 'owner cancellation audit requires review' }
      : LOST_LEASE;
  }
  // foldOwnerRepliesSincePark may recognize and persist a cancellation that
  // arrived after this task was parked. Re-read the action marker after that
  // fold so the fresh cancellation projection, dispatch fences, and final
  // owner-head checks all apply to the same resumed execution.
  hasChecklistCancellation =
    (state.requestChecklist as { lastOwnerAction?: { kind?: unknown } } | undefined)
      ?.lastOwnerAction?.kind === 'cancel';
  if (state.requestChecklist && hasOwnerChecklistCancellationMarker(state.requestChecklist)) {
    const invalidCancellation = await checklistCancellationOwnersAreValid(
      persistence.executionContext,
      task,
      state.requestChecklist,
    );
    if (invalidCancellation) {
      const marked = await markTaskNeedsAttention(
        persistence.tasks,
        lease,
        'owner cancellation evidence could not be verified; no additional action was dispatched',
      );
      return marked
        ? {
            outcome: 'needs_attention',
            detail: `owner cancellation evidence requires review: ${invalidCancellation}`,
          }
        : LOST_LEASE;
    }
  }
  if (hasChecklistCancellation) {
    const checklist = state.requestChecklist;
    const lastAction = checklist?.lastOwnerAction;
    const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload;
    const requestText = payload?.text;
    const cancellationMessageId = lastAction?.ownerMessageId;
    const refuseCancellation = async (reason: string): Promise<ExecuteResult> => {
      const text =
        'I could not safely resume this request after the cancellation. Review it in Activity.';
      return stageFinalResponse(deps, lease, state, rc.window, {
        text,
        progress: `cancellation resume paused for review: ${reason.slice(0, 120)}`,
        terminalStatus: 'needs_attention',
        outcome: 'needs_attention',
        contractNotice: true,
      });
    };
    if (
      lastAction?.kind !== 'cancel' ||
      !checklist ||
      task.type !== 'chat_turn' ||
      task.trust !== 'owner' ||
      task.goalId !== null ||
      !task.conversationId ||
      typeof requestText !== 'string' ||
      typeof cancellationMessageId !== 'string' ||
      state.pendingJob ||
      state.pendingApprovals.length > 0 ||
      state.pendingFinal
    )
      return refuseCancellation('task binding or pending effects are unsupported');

    const originalIntent = latestOwnerIntent([{ role: 'user', content: requestText }], {
      trust: task.trust as Trust,
      trigger: task.trigger,
    });
    cancellationOriginalIntent = originalIntent;
    const cancellationOwnerMessage = await persistence.executionContext.getOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
      messageId: cancellationMessageId,
    });
    const latestOwnerMessage = await persistence.executionContext.getLatestOwnerMessage({
      agentId: task.agentId,
      conversationId: task.conversationId,
    });
    if (!cancellationOwnerMessage || latestOwnerMessage?.id !== cancellationMessageId)
      return refuseCancellation('the exact cancellation message is no longer the owner head');
    cancellation = projectChecklistCancellationResume({
      task: {
        id: task.id,
        agentId: task.agentId,
        conversationId: task.conversationId,
        createdAt: task.createdAt,
      },
      checklist,
      ownerMessage: {
        id: cancellationOwnerMessage.id,
        taskId: cancellationOwnerMessage.taskId ?? '',
        agentId: task.agentId,
        conversationId: task.conversationId,
        role: 'user',
        origin: 'owner',
        text: cancellationOwnerMessage.text,
        createdAt: cancellationOwnerMessage.createdAt,
      },
      latestConversationOwnerMessageId: latestOwnerMessage.id,
      originalIntent,
    });
    if (!cancellation)
      return refuseCancellation('the selected cancellation or remaining work is unsupported');
    const checklistEvidence = await persistence.executionEvidence.taskEvidence({
      agentId: task.agentId,
      taskId: task.id,
    });
    for (const completed of cancellation.completedOutcomes) {
      const item = checklist.items.find((candidate) => candidate.id === completed.id);
      if (
        !item ||
        item.evidence.length === 0 ||
        !item.evidence.every((receipt) =>
          checklistEvidence.some((row) => row.id === receipt.id && row.status === 'succeeded'),
        )
      )
        return refuseCancellation('a completed sibling lacks its durable successful evidence');
    }
    const referenceAtByItem = new Map<string, Date>();
    for (const outcome of cancellation.activeOutcomes) {
      const replacement = (checklist.revisionAudit ?? [])
        .filter((entry) => entry.itemId === outcome.id)
        .at(-1);
      if (!replacement) {
        referenceAtByItem.set(outcome.id, task.createdAt);
        continue;
      }
      const referenceMessage = await persistence.executionContext.getOwnerMessage({
        agentId: task.agentId,
        conversationId: task.conversationId,
        messageId: replacement.ownerMessageId,
      });
      const normalizedMessage = referenceMessage?.text
        .trim()
        .replace(/[.!?]+$/, '')
        .trim();
      const normalizedLabel = replacement.toLabel
        .trim()
        .replace(/[.!?]+$/, '')
        .trim();
      if (
        !referenceMessage ||
        referenceMessage.taskId !== task.id ||
        referenceMessage.role !== 'user' ||
        referenceMessage.origin !== 'owner' ||
        normalizedMessage !== normalizedLabel ||
        !(referenceMessage.createdAt instanceof Date) ||
        !Number.isFinite(referenceMessage.createdAt.getTime())
      )
        return refuseCancellation('a retained lookup has no exact owner-message time anchor');
      referenceAtByItem.set(outcome.id, referenceMessage.createdAt);
    }
    cancellation = {
      ...cancellation,
      activeOutcomes: cancellation.activeOutcomes.map((outcome) => ({
        ...outcome,
        referenceAt: referenceAtByItem.get(outcome.id) ?? task.createdAt,
      })),
    };
    const firstLookup = cancellation.activeOutcomes.find((outcome) => outcome.status === 'pending');
    if (
      firstLookup &&
      !taskBoundCorrectionReadRequest(firstLookup.label, {
        now: firstLookup.referenceAt,
        timeZone: state.requestTimeZone ?? agent.timezone,
        authorizedScopes: cancellation.authorizedScopes,
      })
    )
      return refuseCancellation('a retained lookup is outside the original private-read authority');
    const cancellationWindow = [
      {
        role: 'system',
        content: `Resume only task ${task.id}, cancellation revision ${cancellation.cancellationRevision}. The owner cancelled outcomes ${cancellation.cancelledOutcomeIds.join(', ')}. Preserve completed outcomes and perform only the remaining pending private lookups listed in the validated checklist. Do not perform writes or any cancelled action.`,
      },
      { role: 'user', content: cancellationOwnerMessage.text },
    ] as unknown as TaskState['contextWindow'];
    state.contextWindow = cancellationWindow;
    rc.window = cancellationWindow as unknown as ModelMessage[];
    rc.checklistCancellation = cancellation;
    rc.ctx.ownerIntent = originalIntent;
  }
  // Rebuild persisted conversations.search evidence before a resumed planner or
  // model can consume a pre-park private result. This is a local bounded text
  // refresh; it never replays embedding or arbitrary tools.
  const refreshedSearch = correction
    ? { changed: false, observationGeneration: 0 }
    : await refreshResumedConversationSearch(rc.window, {
        agentId: task.agentId,
        ...(task.conversationId ? { currentConversationId: task.conversationId } : {}),
        repository: persistence.conversationSearch,
      });
  if (refreshedSearch.changed) {
    state.plannerState.conversationSearchObservationGeneration =
      refreshedSearch.observationGeneration;
    state.contextWindow = compact(rc.window) as unknown as TaskState['contextWindow'];
    if (!(await checkpointTask(persistence.tasks, lease, state, { preserveFailureCounters: true })))
      return LOST_LEASE;
  }
  // The fold can append a newer owner-authored instruction. Refresh the typed
  // intent and forced step-zero routes from that window before any planning or
  // dispatch; otherwise the dispatcher could keep using the pre-resume scope.
  const resumedOwnerIntent = correction
    ? ownerIntent
    : (cancellationOriginalIntent ??
      latestOwnerIntent(rc.window, {
        trust: task.trust as Trust,
        trigger: task.trigger,
        clarificationContinuation: state.clarificationContinuation,
      }));
  rc.ctx.ownerIntent = ownerIntentForResolvedRead(resumedOwnerIntent, resolvedReadIntent);
  const resumedOwnerWindow = ownerAuthoredWindow(rc.window, resumedOwnerIntent);
  rc.artifactIntent =
    !correction && !cancellation && state.step === 0 && !isKnownReply
      ? requestedArtifactIntent(resumedOwnerIntent.ownerAuthoredText)
      : undefined;
  rc.documentReadIntent =
    !correction && !cancellation && state.step === 0 && !rc.artifactIntent && !isKnownReply
      ? await unreadSharedDocumentIntent(persistence.executionEvidence, task, resumedOwnerWindow)
      : undefined;
  const payload = (task.trigger as { payload?: { text?: unknown } } | null)?.payload;
  // Never promote an older conversation message into fresh authorization.
  const originalRequest = typeof payload?.text === 'string' ? payload.text : '';
  if (
    !state.requestChecklist &&
    task.trust === 'owner' &&
    !shouldTaintContext(task) &&
    !isForwardedIngest(task) &&
    (task.type === 'chat_turn' || task.type === 'sms_turn')
  ) {
    state.requestChecklist = buildRequestChecklist(originalRequest);
  }
  if (
    state.requestChecklist &&
    !(await checkpointTask(persistence.tasks, lease, state, { preserveFailureCounters: true }))
  )
    return LOST_LEASE;

  // Save-status questions are read-only receipt checks, not new work for a
  // planner to invent or clarify. Resolve them before any model call.
  if (
    !correction &&
    task.trust === 'owner' &&
    !isForwardedIngest(task) &&
    !state.untrustedContext &&
    (task.type === 'chat_turn' || task.type === 'sms_turn') &&
    isSaveStatusQuestion(latestUserText(rc.window) ?? '')
  ) {
    const text = await previousSaveStatus(persistence, task);
    rc.window.push({ role: 'assistant', content: text });
    return stageFinalResponse(deps, lease, state, rc.window, {
      text,
      progress: text.slice(0, 200),
      terminalStatus: 'done',
      outcome: 'done',
    });
  }

  // Read an owner-supplied shared document (step 0) before the model continues.
  const documentReadResult = correction || cancellation ? null : await runDirectDocumentRead(rc);
  if (documentReadResult) return documentReadResult;

  const planResult = correction || cancellation ? { plan: null } : await runPlanPhase(rc);
  if ('outcome' in planResult) return planResult;
  if (
    !state.requestChecklist &&
    task.trust === 'owner' &&
    !shouldTaintContext(task) &&
    !isForwardedIngest(task) &&
    (task.type === 'chat_turn' || task.type === 'sms_turn')
  ) {
    state.requestChecklist = buildRequestChecklist(
      originalRequest,
      planResult.plan?.requestedOutcomes,
    );
  }
  if (
    state.requestChecklist &&
    !(await checkpointTask(persistence.tasks, lease, state, { preserveFailureCounters: true }))
  )
    return LOST_LEASE;
  if (correction && correction.activeOutcomes.length === 0) {
    const text =
      correction.completedOutcomes
        .map((outcome) => `${outcome.label}: ${outcome.detail || 'lookup completed'}`)
        .join('\n\n') || 'The corrected checklist has no pending lookup work.';
    const completedIds = new Set(correction.completedOutcomes.map((outcome) => outcome.id));
    return stageFinalResponse(deps, lease, state, rc.window, {
      text,
      progress: 'corrected checklist already complete; no read was repeated',
      terminalStatus: 'done',
      outcome: 'done',
      contractBlocked: false,
      checklistCorrection: {
        revision: correction.revision,
        ownerMessageId: correction.ownerMessageId,
        outcomes: (state.requestChecklist?.items ?? [])
          .filter((item) => completedIds.has(item.id))
          .map((item) => ({
            id: item.id,
            status: 'completed' as const,
            evidenceIds: item.evidence.map((evidence) => evidence.id).sort(),
          })),
      },
    });
  }
  return runStepLoop(rc, planResult.plan);
}
