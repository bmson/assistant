import { loadConfig } from '@assistant/config';
import {
  createPostgresExecutionEvidenceRepository,
  createPostgresGeneratedCardRepository,
  createPostgresNotificationsConversationRepository,
  type Db,
  type TaskRow,
} from '@assistant/db';
import type {
  ExecutionEvidenceRecord,
  ExecutionEvidenceRepository,
  MessageRepository,
  NotificationsConversationRepository,
  SkillContextRepository,
} from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { assistantMessageParts, PROMPT_VERSION, persistMessage } from '../../chat.js';
import { type Cue, stripCueTags } from '../../chat-cues.js';
import { isForwardedIngest } from '../../email-provenance.js';
import type { PendingFinal, TaskState } from '../../events.js';
import {
  cardRuntimeProvenance,
  type GeneratedCardPayload,
  generateEvidenceCard,
  persistGeneratedCard,
  prefersAnswerCard,
  revalidatedCardEvidence,
  scoreboardCardSpec,
} from '../../generative-card.js';
import type { RecallSource } from '../../memory/recall.js';
import { recordSkillOutcome } from '../../memory/skills.js';
import { truncateAtBoundary } from '../../owner-text.js';
import { type ArtifactIntent, artifactExecutionFailure } from '../artifact-intent.js';
import { remainingBirthdaySaves, requestedBirthdaySaves } from '../birthday-import.js';
import { CARD_NOT_BUILT, requestedCardIntent } from '../card-intent.js';
import { responseCardSteps } from '../card-steps.js';
import { isGoalWorkEvidence } from '../goal-evidence.js';
import {
  detectLiveLookups,
  type LookupContext,
  liveLookupCorpus,
  liveLookupFailures,
  ungroundedLiveFigure,
} from '../live-lookup.js';
import {
  checkpointTask,
  completeTask,
  enqueueTask,
  markAttentionNotified,
  markTaskNeedsAttention,
  renewTaskLease,
  type TaskLease,
  taskState,
} from '../machine.js';
import { verifyFinalOutput } from '../output-verification.js';
import { PLANNER_VERSION } from '../planner.js';
import { detectPersonalReadRequest, type PersonalReadRequest } from '../read-intent.js';
import { requestChecklistSummary } from '../request-checklist.js';
import { responseCardsForFinal } from '../response-cards.js';
import {
  type ActionEvidence,
  enforceResponseContract,
  verifiedReadResponse,
} from '../response-contract.js';
import { refreshRequestChecklist } from './checklist.js';
import { isUnattendedGoalSession, KNOWN_SENDER_REPLY_KIND } from './context-helpers.js';
import {
  notifyOwnerAndConversation,
  notifyOwnerOfDeliveredAnswer,
  recordGoalBlocked,
} from './notices.js';
import { type ExecuteResult, type ExecutorDeps, LOST_LEASE } from './types.js';
import { compact, latestUserText } from './util.js';

/**
 * Deferred work is only real once a durable row exists. Left to prose the
 * model answers "I'll keep updating it as I go" — a promise nothing in the
 * system will keep, and which the response contract then has to blank out.
 */
export const SCHEDULE_DIRECTIVE =
  '\nThis turn defers work to the future. Before you finish, call task.schedule with a concrete time and a self-contained instruction (or mission.update if this belongs to a mission). Do not promise to continue, watch, or keep updating anything unless that call succeeded — if you cannot schedule it, say so plainly and do the part you can do now.';

function executionEvidence(deps: ExecutorDeps): ExecutionEvidenceRepository {
  return deps.persistence?.executionEvidence ?? createPostgresExecutionEvidenceRepository(deps.db);
}

function actionEvidence(
  rows: readonly ExecutionEvidenceRecord[],
  fromCurrentTask?: boolean,
): ActionEvidence[] {
  return rows.map((row) => ({
    ...row,
    ...(fromCurrentTask === undefined ? {} : { fromCurrentTask }),
  }));
}

export async function stopForUnsavedGoalProgress(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  reason: string,
): Promise<ExecuteResult> {
  const text =
    "I recorded verified goal activity, but the runtime couldn't save its progress checkpoint. Open Activity and retry this task so the goal does not continue from stale information.";
  console.error('required goal progress was not saved', {
    taskId: task.id,
    reason,
  });
  await recordGoalBlocked(deps, task, text);
  await notifyOwnerAndConversation(
    deps,
    task,
    'A goal recorded verified activity, but its runtime progress write failed. Retry the task from Activity.',
  );
  window.push({ role: 'assistant', content: text } as ModelMessage);
  return stageFinalResponse(deps, task, state, window, {
    text,
    progress: text.slice(0, 200),
    terminalStatus: 'needs_attention',
    outcome: 'needs_attention',
  });
}

/**
 * A retry must not duplicate the dashboard/chat copy of a final response.
 *
 * A conversation-less assistant-trust task (a scheduled/goalless automation)
 * would otherwise deliver its answer NOWHERE — deliverFinal no-ops for non-owner
 * trust and there is no thread to write into. Route those into the assistant's
 * Notifications thread so the owner always sees the result on the dashboard.
 */
async function persistFinalConversationOnce(
  evidence: ExecutionEvidenceRepository,
  messageRepository: MessageRepository | undefined,
  notifications: NotificationsConversationRepository,
  db: Db,
  task: TaskRow,
  text: string,
  recall?: RecallSource[],
  contractNotice?: boolean,
  cues?: Cue[],
  responseCards?: Record<string, unknown>[],
): Promise<boolean> {
  let conversationId = task.conversationId;
  let body = text;
  if (!conversationId) {
    if (task.trust !== 'assistant' || !text.trim()) return false;
    conversationId = await notifications.getOrCreate(task.agentId);
    // The Notifications thread mixes many tasks — title the entry so the owner
    // can tell what produced it.
    const title = task.title?.trim() || 'Scheduled task';
    body = `**${title}**\n\n${text}`;
  }
  const existing = await evidence.finalMessageExists({
    agentId: task.agentId,
    taskId: task.id,
    conversationId,
    text: body,
  });
  // A duplicate from an earlier attempt still means an owner-visible copy exists.
  if (existing) return true;
  const message: Parameters<MessageRepository['append']>[0] = {
    conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: assistantMessageParts(body, recall, { contractNotice, cues, responseCards }),
    text: body,
  };
  if (messageRepository) await messageRepository.append(message);
  else await persistMessage(db, message);
  return true;
}

/** Deliver a previously checkpointed final response, then finish under CAS. */
export async function finalizePendingResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  pending: PendingFinal,
  checkpointState?: TaskState,
): Promise<ExecuteResult> {
  if (!(await renewTaskLease(deps.persistence?.tasks ?? deps.db, task))) return LOST_LEASE;
  const recallSources = (checkpointState ?? taskState(task)).recall ?? undefined;
  const evidence = executionEvidence(deps);
  const conversationDelivered = await persistFinalConversationOnce(
    evidence,
    deps.persistence?.messages,
    deps.persistence?.notifications ?? createPostgresNotificationsConversationRepository(deps.db),
    deps.db,
    task,
    pending.text,
    recallSources,
    pending.contractNotice,
    pending.cues,
    pending.responseCards,
  );

  // Check cancellation/reclaim immediately before the external side effect.
  if (deps.deliverFinal && !pending.deliveryAttempted) {
    // Fence the provider call at-most-once. If the process disappears after
    // provider acceptance but before task completion, the retry assumes this
    // ambiguous attempt may have delivered instead of sending a duplicate.
    pending.deliveryAttempted = true;
    const state = checkpointState ?? taskState(task);
    state.pendingFinal = pending;
    if (!(await checkpointTask(deps.persistence?.tasks ?? deps.db, task, state))) return LOST_LEASE;
    if (!(await renewTaskLease(deps.persistence?.tasks ?? deps.db, task))) return LOST_LEASE;
    try {
      await deps.deliverFinal(task, pending.text);
    } catch (error) {
      // A definitive provider rejection is retryable. Ambiguous transport
      // failures are normalized by channel adapters and do not throw.
      pending.deliveryAttempted = false;
      state.pendingFinal = pending;
      if (!(await checkpointTask(deps.persistence?.tasks ?? deps.db, task, state)))
        return LOST_LEASE;
      throw error;
    }
  }

  // The final text is delivered first either way; only the resting state of
  // the task differs. needs_attention keeps it re-queueable from the Tasks
  // page instead of closing it out as a completed run.
  const completed =
    pending.terminalStatus === 'needs_attention'
      ? await markTaskNeedsAttention(deps.persistence?.tasks ?? deps.db, task, pending.progress)
      : await completeTask(deps.persistence?.tasks ?? deps.db, task, {
          status: pending.terminalStatus,
          progress: pending.progress,
        });
  if (!completed) return LOST_LEASE;
  // Record quality signals here — the single funnel every terminal path AND
  // every resume passes through — so response_checks captures the failures it
  // exists to measure (step-cap exhaustion, forced-no-tool, budget stalls),
  // not just successful prose finals. Best-effort: a metrics write must never
  // fail a completed task.
  await recordQualitySignals(
    evidence,
    deps.db,
    task,
    checkpointState ?? taskState(task),
    pending,
    deps.persistence?.skills,
  ).catch((error) => console.error('quality signal record failed', error));
  // A needs_attention final that reached an owner-visible thread (the task's own
  // conversation or the Notifications sink) is already notified — stamp it so the
  // re-notify sweep leaves it alone. If it delivered nowhere, leave it unstamped
  // so the sweep keeps trying.
  if (pending.terminalStatus === 'needs_attention' && conversationDelivered) {
    await markAttentionNotified(deps.persistence?.tasks ?? deps.db, task.id).catch((err) =>
      console.error('attention stamp failed', err),
    );
  }
  // A dashboard chat turn is the one owner-facing type no channel delivers, so
  // without this its answer lands in the thread and tells nobody. Excludes
  // needs_attention, which has already pinged the owner through the louder
  // notifyOwnerAndConversation path and must not buzz twice for one turn.
  if (
    conversationDelivered &&
    task.trust === 'owner' &&
    task.type === 'chat_turn' &&
    pending.terminalStatus !== 'needs_attention'
  ) {
    await notifyOwnerOfDeliveredAnswer(deps, task, pending.text);
  }
  return { outcome: pending.outcome, detail: pending.progress.slice(0, 200) };
}

/** Persist-before-send turns the task checkpoint into a small durable outbox. */
export async function stageFinalResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  pending: PendingFinal,
): Promise<ExecuteResult> {
  await refreshRequestChecklist(executionEvidence(deps), task, state);
  if (state.requestChecklist?.items.some((item) => item.status !== 'completed')) {
    // A partial success is not the whole request. This is also applied to
    // non-model terminal paths, and checkpointed before channel delivery.
    const draft = pending.text;
    const clarification = pending.outcome === 'clarify' ? `${draft.trimEnd()}\n\n` : '';
    pending.text = `${clarification}This request is not fully completed.\n\n${requestChecklistSummary(state.requestChecklist)}`;
    const last = window.at(-1);
    if (last?.role === 'assistant' && last.content === draft) last.content = pending.text;
    pending.progress = 'Some requested outcomes remain unverified.';
    if (pending.terminalStatus === 'done') {
      pending.terminalStatus = 'needs_attention';
      pending.outcome = 'needs_attention';
    }
  }
  state.pendingFinal = pending;
  state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
  if (!(await checkpointTask(deps.persistence?.tasks ?? deps.db, task, state))) return LOST_LEASE;
  return finalizePendingResponse(deps, task, pending, state);
}

/**
 * Persist the per-task quality signals that used to vanish into console.warn:
 * the response-contract verdict and the loop-health counters, keyed by prompt
 * and planner version so a wording change shows up in the block rate; and the
 * outcome of every skill whose advice was injected, which is what lets a
 * repeatedly failing skill hit its three-strikes deprecation instead of being
 * recommended forever. Best-effort — a metrics write must never fail a final.
 */
async function recordQualitySignals(
  evidence: ExecutionEvidenceRepository,
  db: Db,
  task: TaskRow,
  state: TaskState,
  pending: PendingFinal,
  skills?: SkillContextRepository,
): Promise<void> {
  // The unique task_id + do-nothing makes the row idempotent across delivery
  // retries and resumes; `.returning()` tells us whether THIS call was the one
  // that inserted it.
  const inserted = await evidence.recordResponseCheck({
    agentId: task.agentId,
    check: {
      taskId: task.id,
      promptVersion: PROMPT_VERSION,
      plannerVersion: PLANNER_VERSION,
      blocked: pending.contractBlocked ?? false,
      unsupportedCount: pending.contractUnsupportedCount ?? 0,
      mustActRetries: state.mustActRetries,
      degradedSteps: state.degradedSteps,
      outputVerificationAttempted: pending.outputVerificationAttempted ?? false,
      outputVerificationRevised: pending.outputVerificationRevised ?? false,
      outputVerificationUnavailable: pending.outputVerificationUnavailable ?? false,
    },
  });
  // recordSkillOutcome increments success/failure counters — NOT idempotent —
  // so run it only on the fresh insert. terminalStatus is now the ACTUAL final
  // status (this is called after completion), so a failed/needs_attention run
  // finally records a failure, which is what lets the three-strikes skill
  // deprecation fire instead of a bad skill being recommended forever.
  if (inserted && state.usedSkillIds.length > 0) {
    const success = pending.terminalStatus === 'done';
    await Promise.all(
      state.usedSkillIds.map((id) => recordSkillOutcome(skills ?? db, id, success, task.agentId)),
    );
  }
}

/**
 * The prose model is never the evidence source for an external action. Query
 * the durable ledger immediately before publishing a free-form final answer;
 * this also covers tool failures that were visible to the model but ignored.
 *
 * Two scopes: this task's rows decide whether *this* attempt succeeded, and
 * earlier rows from the same conversation let the contract recognise
 * artifacts that genuinely exist. Without the second scope, referring back to
 * a doc built two turns ago was answered with "I have not created anything
 * outside this chat" — a flat falsehood with the doc sitting in Drive. The
 * response contract still refuses to let prior-turn rows authorise a new
 * send, submission, or booking.
 */
export async function stageModelFinalResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  pending: PendingFinal,
  expectedArtifact?: ArtifactIntent,
  /**
   * The lookup this turn is answering, and the non-tool context it may draw
   * on. Both come from the step loop, which resolved the request against the
   * owner's clock and timezone; re-detecting here would silently produce a
   * request with neither, and the grounding check would then have no window to
   * measure a stated time against.
   */
  readContext?: {
    readRequest?: PersonalReadRequest | null;
    groundingCorpus?: string;
    /** The owner's clock, which resolves "my 3pm" to one calendar event. */
    lookupContext?: LookupContext;
  },
): Promise<ExecuteResult> {
  // Companion cue tags come out for EVERY channel before the contract or any
  // delivery sees the text. The prompt gates the vocabulary to dashboard chat,
  // but a leaked tag in an email or SMS final would be robot syntax in front
  // of a human — stripping here is the defense in depth. The cues themselves
  // survive only into a dashboard chat_turn's persisted parts, below.
  const strippedFinal = stripCueTags(pending.text);
  pending.text = strippedFinal.text;
  const evidenceRepository = executionEvidence(deps);
  const rows = await evidenceRepository.taskEvidence({ agentId: task.agentId, taskId: task.id });
  const priorRows = task.conversationId
    ? await evidenceRepository.conversationEvidence({
        agentId: task.agentId,
        conversationId: task.conversationId,
        excludeTaskId: task.id,
      })
    : [];
  const evidence: ActionEvidence[] = [...actionEvidence(priorRows, false), ...actionEvidence(rows)];
  // owner.notify already persisted this scheduled reminder. Reuse its exact
  // delivered text so a paraphrase or "Done" cannot create a second message.
  if (task.type === 'scheduled' && rows.length === 1) {
    const notification = rows[0];
    const result = notification?.result as { notified?: boolean } | null;
    const args = notification?.args as { message?: string } | null;
    if (
      notification?.toolName === 'owner.notify' &&
      notification.status === 'succeeded' &&
      result?.notified === true &&
      args?.message
    ) {
      return stageFinalResponse(deps, task, state, window, { ...pending, text: args.message });
    }
  }
  const currentRequest = window.slice(
    0,
    window.findLastIndex((message) => message.role === 'user') + 1,
  );
  const liveLookups =
    task.trust === 'owner' && !isForwardedIngest(task) ? detectLiveLookups(currentRequest) : [];
  // A lookup that succeeded is not the same as an answer that matches it. The
  // failure check proves retrieval happened; the figure check proves the draft
  // reported what was retrieved, which is the half that let a stale score
  // through over a successful fetch that said otherwise. A compound request
  // may lose some parts — the draft then reports those gaps itself — but an
  // answer with nothing retrieved, or a figure no source stated, still stops.
  const liveFailures = liveLookupFailures(liveLookups, rows, readContext?.lookupContext);
  const answered = liveLookups.filter(
    (lookup) => !liveFailures.some((entry) => entry.lookup === lookup),
  );
  const ungroundedFigure = answered
    .map((lookup) => ungroundedLiveFigure(lookup, pending.text, rows))
    .find(Boolean);
  const liveFailure =
    liveLookups.length === 0
      ? undefined
      : liveFailures.length === liveLookups.length
        ? [...new Set(liveFailures.map((entry) => entry.failure))].join(' ')
        : ungroundedFigure;
  const birthdays =
    task.trust === 'owner' && !isForwardedIngest(task)
      ? requestedBirthdaySaves(currentRequest)
      : [];
  if (birthdays.length > 0) {
    const remaining = remainingBirthdaySaves(birthdays, rows);
    const saved = birthdays.length - remaining.length;
    const graphUnverified = /\bgraph\b/i.test(latestUserText(window) ?? '');
    const incomplete = remaining.length > 0 || graphUnverified;
    const text = `Saved ${saved} of ${birthdays.length} supplied dated birthday entries to long-term memory. Names, dates, and supplied notes were preserved. Entries without a date were left unchanged.${remaining.length ? ` Still unsaved: ${remaining.map((entry) => entry.subject).join(', ')}.` : ''}${graphUnverified ? ' Graph attachments are not yet verified.' : ''}`;
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text,
      progress: text.slice(0, 200),
      terminalStatus: incomplete ? 'needs_attention' : 'done',
      outcome: incomplete ? 'needs_attention' : 'done',
    });
  }
  if (liveFailure) {
    // Beside a calendar or mail read, a failed or unsupported lookup is one
    // part of the answer: the read half comes straight from its ledger, and
    // the gap is named under it rather than replacing the whole reply.
    const mixedRead = readContext?.readRequest;
    const cards = responseCardsForFinal({
      evidence: actionEvidence(rows),
      readRequest: mixedRead,
      requestText: latestUserText(window),
      lookupOrder: liveLookups.map((lookup) => lookup.kind),
    });
    const gap =
      ungroundedFigure && cards.length > 0
        ? liveFailure.replace(
            'The lookup needs to be retried.',
            'The verified source data is shown below.',
          )
        : liveFailure;
    const text = mixedRead ? `${verifiedReadResponse(mixedRead, evidence)}\n\n${gap}` : gap;
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text,
      progress: text.slice(0, 200),
      terminalStatus: 'needs_attention',
      outcome: 'needs_attention',
      contractBlocked: Boolean(ungroundedFigure),
      contractUnsupportedCount: ungroundedFigure ? 1 : 0,
      contractNotice: true,
      ...(cards.length ? { responseCards: cards } : {}),
    });
  }
  const explicitFailure = expectedArtifact
    ? artifactExecutionFailure(expectedArtifact, rows)
    : undefined;
  if (explicitFailure) {
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text: explicitFailure,
      progress: explicitFailure.slice(0, 200),
      terminalStatus: 'failed',
      outcome: 'failed',
    });
  }
  // Corpus for the URL-provenance rule: every tool result (both scopes), the
  // trigger, and the owner/tool turns — but NOT the assistant's own final, which
  // is already in the window and must not evidence its own fabricated link.
  const sourceCorpus = [
    JSON.stringify(evidence),
    JSON.stringify(task.trigger ?? {}),
    window
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n'),
  ].join('\n');
  const contractOptions = {
    requestText:
      task.trust === 'owner' && !isForwardedIngest(task) ? latestUserText(window) : undefined,
    urlCorpus: sourceCorpus,
    readRequest: readContext ? readContext.readRequest : detectPersonalReadRequest(window),
    groundingCorpus: readContext?.groundingCorpus,
    liveCorpus: liveLookups.length > 0 ? liveLookupCorpus(rows) : undefined,
  };
  // Hold the original draft to the deterministic contract before asking a
  // model to reflect on it. Contract-owned fallbacks (unsupported claims,
  // grounding recovery, or stripped links) are already the safest available
  // answer and must not be reworded by a discretionary model call.
  const initialCheck = enforceResponseContract(pending.text, evidence, contractOptions);
  const canReflect =
    !initialCheck.blocked &&
    initialCheck.text === pending.text &&
    initialCheck.groundingFallback === undefined;
  const latestOwnerIndex = window.findLastIndex((message) => message.role === 'user');
  const reflection = canReflect
    ? await verifyFinalOutput(deps.router, {
        taskId: task.id,
        request: latestUserText(window) ?? task.title ?? 'Answer the current request.',
        draft: initialCheck.text,
        evidence,
        critical: task.trust === 'owner',
        context:
          task.trust === 'owner' && !isForwardedIngest(task)
            ? window.slice(0, Math.max(0, latestOwnerIndex))
            : undefined,
      })
    : { text: initialCheck.text, attempted: false, revised: false, unavailable: false };
  // A reviser is another generative surface: strip companion tags a second
  // time, then re-run the same authoritative response contract before publish.
  const reflectedText = stripCueTags(reflection.text).text;
  const reflectedCheck = reflection.revised
    ? enforceResponseContract(reflectedText, evidence, contractOptions)
    : initialCheck;
  // Optional review may improve a checked draft, but cannot replace it with
  // a rejected invention or a weaker contract fallback. Keep the useful
  // original answer and record the review correction as a reliability signal.
  const rejectedRevision =
    reflection.revised &&
    (reflectedCheck.blocked ||
      reflectedCheck.qualityFallback ||
      reflectedCheck.groundingFallback !== undefined ||
      reflectedCheck.text !== reflectedText);
  const checked = rejectedRevision ? initialCheck : reflectedCheck;
  if (rejectedRevision) {
    console.warn('rejected optional final-response revision; preserving checked draft', {
      taskId: task.id,
      unsupported: reflectedCheck.unsupported,
      groundingFallback: reflectedCheck.groundingFallback,
    });
  }
  if (checked.groundingFallback && checked.groundingFallback.length > 0) {
    console.warn('lookup answer fell back to the verified ledger', {
      taskId: task.id,
      reasons: checked.groundingFallback,
    });
  }
  // Cards are a view of the same ledger that the response contract used; prose
  // is deliberately not parsed here, so a fluent answer cannot invent a card.
  // A trip to "my 3pm" read a day and a half of calendar to find one event.
  // That read is the trip's first step, not an agenda the owner asked to see.
  const tripOwnsCalendar = liveLookups.some((lookup) => lookup.destination === 'calendar');
  const specializedCards = responseCardsForFinal({
    evidence: tripOwnsCalendar
      ? evidence.filter((row) => row.toolName !== 'calendar.list_events')
      : evidence,
    readRequest: contractOptions.readRequest,
    ambient: readContext?.groundingCorpus,
    requestText: latestUserText(window),
    lookupOrder: liveLookups.map((lookup) => lookup.kind),
  });
  // An explicit "make that into a card" must reach the grounded compiler even
  // when a handwritten card already matched this turn. Without this, the
  // resource card for a docs.create — or the email-results card for the very
  // lookup the owner is pointing at — silently swallowed the request, which is
  // how an asked-for card came back as a Google Doc. Coherent object questions
  // also prefer a composed answer; their raw lookup trail stays secondary.
  const ownerRequest = latestUserText(window) ?? '';
  const cardRequested = requestedCardIntent(ownerRequest);
  const answerCardPreferred = prefersAnswerCard(ownerRequest);
  const trigger = task.trigger as { payload?: { refreshCardId?: unknown } } | null;
  const refreshCardId =
    task.trust === 'owner' && typeof trigger?.payload?.refreshCardId === 'string'
      ? trigger.payload.refreshCardId
      : undefined;
  const generatedCardsRepository =
    deps.persistence?.generatedCards ?? createPostgresGeneratedCardRepository(deps.db);
  const refreshTarget = refreshCardId
    ? await generatedCardsRepository.get(task.agentId, refreshCardId)
    : undefined;
  const provenance = cardRuntimeProvenance(refreshTarget?.revision.spec);
  const refreshEvidence = provenance ? revalidatedCardEvidence(provenance.sources, evidence) : null;
  let generatedCard: GeneratedCardPayload | undefined;
  // A scoreboard is already the structured answer and keeps ticking in chat.
  // "Make a card for it" saves a copy compiled from the same rows; the model
  // composer, built for prose pages, is where score cards used to fail.
  const scoreboard = refreshCardId
    ? undefined
    : specializedCards.find((card) => card.kind === 'scoreboard');
  let savedScoreCard: GeneratedCardPayload | undefined;
  if (scoreboard && cardRequested && !checked.blocked) {
    const compiled = scoreboardCardSpec(evidence);
    savedScoreCard = compiled
      ? await persistGeneratedCard(generatedCardsRepository, {
          agentId: task.agentId,
          conversationId: task.conversationId,
          payload: compiled,
          evidence,
          sourceText: ownerRequest,
        }).catch((error) => {
          console.error('scoreboard card persistence failed', error);
          return undefined;
        })
      : undefined;
    if (savedScoreCard && state.requestChecklist) {
      state.requestChecklist.savedCards = [
        {
          id: savedScoreCard.id,
          revisionId: savedScoreCard.revisionId,
          title: savedScoreCard.spec.title,
        },
      ];
    }
  }
  if (
    !scoreboard &&
    (refreshCardId || cardRequested || answerCardPreferred || specializedCards.length === 0) &&
    (!refreshCardId || refreshEvidence) &&
    !checked.blocked &&
    loadConfig().GENERATIVE_CARDS_ENABLED
  ) {
    const sourceText = refreshCardId
      ? (provenance?.requestText ?? '')
      : [
          latestUserText(window) ?? task.title ?? '',
          window
            .filter((message) => message.role === 'user')
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
            )
            .join('\n'),
        ].join('\n');
    const generated = await generateEvidenceCard({
      router: deps.router,
      taskId: task.id,
      sourceText,
      evidence: refreshCardId ? (refreshEvidence ?? []) : evidence,
      sourceKey: task.externalEventId ?? task.id,
      explicitRequest: Boolean(refreshCardId) || cardRequested,
      evidenceOnly: Boolean(refreshCardId),
      // A turn that called no tool has only its own reply to stand on. The
      // composer admits it as evidence in that case alone, under the same
      // verbatim rule, which is what the phone's hand-written kinds used to do
      // with a regex per fact.
      answerText: checked.text,
    });
    if (generated) {
      /*
       * A card read out of this turn's own reply is a view of the answer, not
       * an object the owner acquired: "leave around 2:45" is wrong by tomorrow
       * and belongs in the conversation it was said in. It rides the chat
       * payload and is never filed, so the Cards page keeps holding tickets,
       * reservations and deliveries — the things worth going back to. An
       * explicit "save that as a card" is a deliberate object and still files.
       */
      const answerGrounded = generated.grounding === 'answer' && !cardRequested;
      generatedCard = answerGrounded
        ? generated
        : await persistGeneratedCard(generatedCardsRepository, {
            agentId: task.agentId,
            conversationId: task.conversationId,
            payload: generated,
            evidence: refreshCardId ? (refreshEvidence ?? []) : evidence,
            sourceText,
            refreshCardId,
          }).catch((error) => {
            console.error('generated card persistence failed', error);
            return undefined;
          });
      if (generatedCard && !answerGrounded && state.requestChecklist) {
        state.requestChecklist.savedCards = [
          {
            id: generatedCard.id,
            revisionId: generatedCard.revisionId,
            title: generatedCard.spec.title,
          },
        ];
      }
    }
  }
  /*
   * A composed card IS the answer, and the specialized cards behind it are the
   * lookups that fed it — the mailbox search, the thread it opened. Sending all
   * three answered one request with three cards, two of them the assistant's
   * homework. The composed card takes the trail instead: same provenance, one
   * card, folded into a row the reader can open.
   *
   * The trail rides on the chat payload only. `persistGeneratedCard` has
   * already stored the card itself, so what the Cards page keeps stays the
   * card — not the story of the turn that happened to build it.
   *
   * With no composed card the specialized cards ARE the answer ("show me that
   * email"), and they keep the rendering they have always had.
   */
  const steps = generatedCard ? responseCardSteps(evidence) : [];
  // Refresh replaces the original card through hydration. Its new chat message
  // is a compact receipt, never a second copy of the same saved object.
  const cards = refreshCardId
    ? []
    : generatedCard
      ? [{ ...generatedCard, ...(steps.length > 0 ? { steps } : {}) }]
      : answerCardPreferred || refreshCardId
        ? specializedCards.filter(
            (card) =>
              ![
                'email-results',
                'email-thread',
                'drive-results',
                'document-results',
                'web-search-results',
              ].includes(card.kind),
          )
        : specializedCards;
  if (cards.length > 0) pending.responseCards = cards;
  // A requested card that could not be grounded must say so. Staying quiet let
  // the prose claim a card the Cards page never received.
  const text = refreshCardId
    ? generatedCard
      ? `Refreshed “${generatedCard.spec.title}” from its sources.\n\n${truncateAtBoundary(checked.text.trim(), 500)}`
      : 'I could not verify the latest source data, so I left your saved card unchanged. Please try again.'
    : scoreboard && cardRequested && !checked.blocked
      ? savedScoreCard
        ? `${checked.text.trim()}\n\nSaved “${savedScoreCard.spec.title}” to your Cards page; the scoreboard here stays live while the game is on.`
        : CARD_NOT_BUILT
      : cardRequested && !checked.blocked
        ? generatedCard
          ? `Saved “${generatedCard.spec.title}” to your Cards page.`
          : CARD_NOT_BUILT
        : checked.text;
  if ((cardRequested || refreshCardId) && !generatedCard && !savedScoreCard) {
    pending.terminalStatus = 'needs_attention';
    pending.outcome = 'needs_attention';
  }
  // Stamp the contract verdict on pending; recordQualitySignals reads it from
  // the single funnel in finalizePendingResponse, so every terminal path — not
  // just this prose-model one — persists its verdict and loop-health counters.
  pending.contractBlocked = checked.blocked || (rejectedRevision && reflectedCheck.blocked);
  pending.contractUnsupportedCount = Math.max(
    checked.unsupported.length,
    rejectedRevision ? reflectedCheck.unsupported.length : 0,
  );
  // A transparent replacement is a truthful reply, not proof the requested
  // work finished. Keep unresolved effects visible and re-queueable. Grounded
  // factual corrections with no missing effect may still complete normally.
  if (checked.qualityFallback || checked.unsupported.length > 0) {
    pending.terminalStatus = 'needs_attention';
    pending.outcome = 'needs_attention';
  }
  pending.outputVerificationAttempted = reflection.attempted || undefined;
  pending.outputVerificationRevised = reflection.revised || undefined;
  pending.outputVerificationUnavailable = reflection.unavailable || undefined;
  // When the contract replaces the draft, its deterministic copy carries no
  // emotional register — dropping the cues lets the dashboard fall back to its
  // neutral face instead of grinning through an honesty notice.
  pending.cues =
    task.type === 'chat_turn' &&
    !checked.blocked &&
    (!reflection.revised || rejectedRevision) &&
    strippedFinal.cues.length > 0
      ? strippedFinal.cues
      : undefined;
  if (checked.blocked) {
    console.warn('blocked unsupported assistant action claim', {
      taskId: task.id,
      unsupported: checked.unsupported,
      toolCalls: rows.map((row) => ({
        toolName: row.toolName,
        status: row.status,
      })),
    });
  }
  // An automatic goal session that produced no verified tool result did no
  // work, whatever its prose says. Surfacing it as needs_attention is what
  // turns a goal that is quietly spinning into one the owner can see is stuck.
  if (isUnattendedGoalSession(task) && !rows.some(isGoalWorkEvidence)) {
    await recordGoalBlocked(deps, task, text);
    await notifyOwnerAndConversation(
      deps,
      task,
      `Your goal's background run finished without getting anything verified done, so it needs you: ${text}`,
    );
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text,
      progress: text.slice(0, 200),
      terminalStatus: 'needs_attention',
      outcome: 'needs_attention',
      contractNotice: checked.blocked || undefined,
    });
  }
  // A known contact's plain answer would otherwise dead-end in the dashboard;
  // propose it back to them (owner-approved) so the thread does not go silent.
  await maybeEnqueueKnownSenderReply(deps, task, text);
  return stageFinalResponse(deps, task, state, window, {
    ...pending,
    text,
    progress: text.slice(0, 200),
    contractNotice: checked.blocked || undefined,
  });
}

/**
 * D9 — close the known-sender email dead-end.
 *
 * A KNOWN contact (an authenticated, non-owner sender) whose email_triage task
 * ends in a plain answer or a clarify question gets NOTHING back: deliverEmailFinal
 * auto-sends only to the owner, so the drafted reply lands solely in the dashboard
 * and the sender's thread goes silent. When the triage model itself took no
 * outbound action (no gmail.send / gmail.create_draft row), deterministically
 * enqueue an assistant-trust adhoc child that PROPOSES exactly that reply via
 * gmail.send. Because gmail.send is risk:'approval', the owner sees the approval
 * card and approves or denies — nothing is ever auto-sent to a third party. The
 * child is stamped taintedOrigin (S1): the draft derives from the sender's own
 * message, so the child runs tainted and every outward call stays gated.
 *
 * Unknown senders are unchanged (dashboard only). Idempotent on externalEventId:
 * a finalization retry never enqueues a duplicate child.
 */
export async function maybeEnqueueKnownSenderReply(
  deps: ExecutorDeps,
  task: TaskRow,
  draft: string,
): Promise<void> {
  const conversationId = task.conversationId;
  if (task.type !== 'email_triage' || task.trust !== 'known' || !conversationId) return;
  // Forwarded ingest is never a conversation with the sender: the owner routed
  // their mail here to be read, not to have the assistant answer it on their
  // behalf. Proposing a reply would put an approval card in front of the owner
  // for a message they never asked to answer.
  if (isForwardedIngest(task)) return;
  const reply = draft.trim();
  if (!reply) return;

  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const asStr = (v: unknown) => (typeof v === 'string' ? v : '');
  const to = asStr(payload.from);
  const threadId = asStr(payload.threadId);
  // Without an authenticated recipient and a thread to reply on there is nothing
  // to send; leave the answer in the dashboard as before.
  if (!to || !threadId) return;
  const subject = asStr(payload.subject);
  const rfcMessageId = asStr(payload.rfcMessageId);

  // If the triage model already drafted or sent a reply of its own, a reply path
  // exists — do not propose a second one. (gmail.send parks for approval before
  // it could reach this finalization, but a resumed-and-sent call leaves a row.)
  if (
    await executionEvidence(deps).hasOutboundReply({
      agentId: task.agentId,
      taskId: task.id,
    })
  )
    return;

  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
  const instruction = [
    `A known contact (${to}) emailed you, and this reply has been drafted for them.`,
    `Send it now by calling gmail.send exactly once with to: ["${to}"], subject: ${JSON.stringify(
      replySubject,
    )}, threadId: "${threadId}", and body set to the draft below VERBATIM.`,
    'Do not rewrite, shorten, translate, or add to the draft, and do not call any other tool. gmail.send always requires the owner to approve the exact message before anything is sent.',
    '',
    'Draft to send:',
    reply,
  ].join('\n');

  await enqueueTask(deps.persistence?.tasks ?? deps.db, {
    event: {
      source: 'internal',
      externalEventId: `known-sender-reply:${task.id}`,
      agentId: task.agentId,
      conversationId,
      trust: 'assistant',
      payload: {
        kind: KNOWN_SENDER_REPLY_KIND,
        to,
        threadId,
        subject: replySubject,
        rfcMessageId,
        draft: reply,
        instruction,
        // External provenance carried forward so the child runs tainted and any
        // outward call it makes stays approval-gated.
        taintedOrigin: true,
      },
    },
    type: 'adhoc',
    parentTaskId: task.id,
    // Fixed next action: send the drafted reply. A pre-set plan skips planning so
    // the executor forces the tool call on step 0 (mustAct) rather than leaving
    // it to the planner.
    plan: {
      action: 'workflow',
      reasoning: 'Propose the drafted reply to the known sender for owner approval',
      steps: ['Send the drafted reply via gmail.send (owner-approved)'],
      missingInfo: [],
    },
    maxSteps: 4,
  });
}
