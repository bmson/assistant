import { type Config, modelProviderConfigProblems } from '@assistant/config';
import {
  assistantMessageParts,
  BACKGROUND_NOTICE_MARKER,
  buildSystemPrompt,
  createChatTask,
  encodeMessageCursor,
  type TurnFailureReason,
} from '@assistant/core/chat';
import {
  type Cue,
  createCueScanner,
  spokenReplyLines,
  stripCueTags,
} from '@assistant/core/chat-cues';
import { conversationMessageTexts } from '@assistant/core/conversation-context';
import { TRIAGED_ACTIONABLE } from '@assistant/core/events';
import { getAmbientBlock } from '@assistant/core/memory/ambient';
import { listOpenCommitments, renderOpenCommitments } from '@assistant/core/memory/commitments';
import { getOwnerCard } from '@assistant/core/memory/consolidation';
import { recallKnowledgeGraph, recallWithGraphFallback } from '@assistant/core/memory/graph-recall';
import { type RecallSource, recallRelevantContext } from '@assistant/core/memory/recall';
import { recordRecallMetric } from '@assistant/core/memory/recall-metrics';
import type { ModelRouter, StreamOutcome } from '@assistant/core/model-router';
import { isSituationRequest } from '@assistant/core/situations-schema';
import { buildAutonomyGrant } from '@assistant/core/workflow/autonomy';
import { enqueueTask } from '@assistant/core/workflow/machine';
import { detectPersonalReadRequest } from '@assistant/core/workflow/read-intent';
import {
  clearGoalBlockedOnOwnerReply,
  goalIdForConversation,
} from '@assistant/core/workflow/schedules';
import { isRepairFeedback, reportRepair } from '@assistant/core/workflow/self-repair';
import {
  createPostgresApplicationChatPersistence,
  createPostgresSelfRepairRepository,
  type Db,
} from '@assistant/db';
import type {
  ApplicationChatMessage,
  ApplicationChatPersistence,
  ExecutionPersistence,
  TaskLease,
} from '@assistant/persistence';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import { requestSavedCardRefresh, savedCardRefreshId } from './cards.js';
import { budgetReplyTarget, isApprovalReply } from './chat-budget-reply.js';
import { pumpWithCues, type StreamChunk } from './chat-cue-stream.js';
import { guardDraft } from './chat-guard.js';
import { looksLikeActionRequest } from './chat-triage.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_USER_MESSAGE_BYTES = 16 * 1024;
const MAX_MODEL_HISTORY_BYTES = 64 * 1024;
const MODEL_HISTORY_LIMIT = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatTurnDependencies {
  config: Config;
  /** PostgreSQL compatibility during cutover; Firestore composition omits it. */
  db?: Db;
  router: ModelRouter;
  chat?: ApplicationChatPersistence;
  persistence?: ExecutionPersistence;
}

function hasBackgroundPart(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const { type, data } = part as { type?: unknown; data?: unknown };
    if (type === 'notice' || type === 'suggestion' || type === 'approval-summary') return true;
    return (
      type === 'data-card' &&
      Boolean(data) &&
      typeof data === 'object' &&
      (data as { kind?: unknown }).kind === 'proactive-alert'
    );
  });
}

async function applicationBackgroundNoticeIds(
  chat: ApplicationChatPersistence,
  agentId: string,
  rows: ApplicationChatMessage[],
): Promise<Set<string>> {
  const notices = new Set<string>();
  const pending = new Map<string, string[]>();
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    if (hasBackgroundPart(row.parts)) {
      notices.add(row.id);
      continue;
    }
    if (!row.taskId) continue;
    pending.set(row.taskId, [...(pending.get(row.taskId) ?? []), row.id]);
  }
  const kinds = await chat.getTaskKinds(agentId, [...pending.keys()]);
  for (const [taskId, ids] of pending) {
    if (kinds.get(taskId) === 'chat_turn') continue;
    for (const id of ids) notices.add(id);
  }
  return notices;
}

function goalIdFromConversation(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' && UUID_RE.test(goalId) ? goalId : undefined;
}

async function finishApplicationChatTask(
  chat: ApplicationChatPersistence,
  agentId: string,
  task: TaskLease,
  outcome: {
    status: 'done' | 'failed';
    progress?: string;
    responseText?: string;
    recall?: RecallSource[];
    cues?: Cue[];
    offCourse?: boolean;
    failureNotice?: { text: string; reason: TurnFailureReason };
  },
): Promise<boolean> {
  const messages = [];
  if (outcome.responseText !== undefined && task.conversationId) {
    messages.push({
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: assistantMessageParts(outcome.responseText, outcome.recall, {
        cues: outcome.cues,
        offCourse: outcome.offCourse,
      }),
      text: outcome.responseText,
    });
  }
  if (outcome.status === 'failed' && outcome.failureNotice && task.conversationId) {
    messages.push({
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: assistantMessageParts(outcome.failureNotice.text, undefined, {
        turnFailed: outcome.failureNotice.reason,
      }),
      text: outcome.failureNotice.text,
    });
  }
  return chat.completeDirectChatTask({
    agentId,
    task,
    status: outcome.status,
    progress: outcome.progress,
    messages,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Compact, ASCII-safe recall provenance for the x-recall response header. */
function encodeRecallHeader(sources: RecallSource[]): string {
  const trimmed = sources.slice(0, 3).map((s) => ({
    date: s.date,
    label: s.label.slice(0, 60),
    ...(s.kind ? { kind: s.kind } : {}),
    ...(s.hops ? { hops: s.hops } : {}),
  }));
  return encodeURIComponent(JSON.stringify(trimmed));
}

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(body) };
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => {
      return part?.type === 'text' && typeof part.text === 'string';
    })
    .map((part) => part.text)
    .join('\n');
}

/**
 * The durable record a failed turn leaves in the thread, rendered by the chat
 * as a failure card with a retry — never as assistant prose, and never as
 * nothing (a reload used to erase every trace that the turn died).
 */
const TURN_FAILURE_COPY: Record<TurnFailureReason, string> = {
  model: "This reply didn't make it — the model service failed. Trying again usually works.",
  budget:
    'This reply was stopped by your spending cap. Raise it on the Costs page, then try again.',
  empty: 'The model returned an empty reply. Trying again usually works.',
};

/**
 * Does this turn ask the assistant to DO something (tools/actions), or just
 * converse? Action turns run through the real executor — planner, tools, risk
 * gate, approvals — because this streaming route has NO tools, and a tool-less
 * model asked to act will role-play acting (that is exactly the hallucinated
 * "email sent" bug this triage exists to prevent).
 */
const NeedsActionSchema = z.object({
  needsAction: z
    .boolean()
    .describe(
      'true if the user asks the assistant to DO or CHECK something (send email/SMS, schedule, book, buy, browse the web, look at inbox/calendar — e.g. "look at my calendar", "what\'s on my schedule", "tell me my flights" — remember something, set a reminder, run a task) — false for plain conversation, questions answerable from general knowledge, or feedback.',
    ),
});

/**
 * Action turns are accepted by the workflow queue rather than answered in this
 * request. The client learns about the hand-off from the x-async-task header
 * and polls for the durable reply, so the stream itself carries only a
 * transient marker: a transient data part is delivered to the client without
 * entering the message, so no placeholder text ever lands in the log to be
 * recognised and dropped later.
 */
function acceptedStreamResponse(taskId: string, headers: Record<string, string>): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'data-task-accepted',
        data: { taskId },
        transient: true,
      });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
  return createUIMessageStreamResponse({ stream, headers });
}

function boundedModelHistory(
  rows: ApplicationChatMessage[],
  notices: ReadonlySet<string>,
): UIMessage[] {
  const contextTexts = conversationMessageTexts(rows, notices);
  const newestFirst = [...rows]
    .reverse()
    .filter((row) => row.role === 'user' || row.role === 'assistant');
  const selected: UIMessage[] = [];
  let bytes = 0;
  for (const row of newestFirst) {
    // A delivered reminder or pulse alert sits in this thread like any reply.
    // Name it, or the model answers the owner's question and then reads the
    // notice back to them as part of the answer.
    const text = notices.has(row.id)
      ? `${BACKGROUND_NOTICE_MARKER}\n${row.text}`
      : (contextTexts.get(row.id) ?? row.text);
    const nextBytes = byteLength(text);
    // Keep a contiguous recent suffix; silently reaching far around one huge
    // message produces misleading context.
    if (bytes + nextBytes > MAX_MODEL_HISTORY_BYTES) break;
    bytes += nextBytes;
    selected.push({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: [{ type: 'text', text }],
    });
  }
  return selected.reverse();
}

/**
 * The owner's unfinished business, rendered for the prompt.
 *
 * Best-effort by contract: this is background colour for a reply, so a failure
 * to read it degrades the answer but must never fail the turn. It is gathered
 * alongside the turn's other context reads, which is the only reason it is a
 * named function — an inline closure inside that gather could not be tested.
 */
export async function openLoopContext(
  db: Parameters<typeof listOpenCommitments>[0],
  agentId: string,
  query: string,
): Promise<string | undefined> {
  try {
    return (
      renderOpenCommitments(await listOpenCommitments(db, { agentId, query, limit: 6 })) ||
      undefined
    );
  } catch (err) {
    console.error('open-loop context failed — continuing without it', err);
    return undefined;
  }
}

/**
 * This turn's task row, and the goal bookkeeping that has to precede it.
 *
 * Same goal link as the action-routed path: an owner reply in a goal's work
 * chat answers whatever question had that goal blocked, so the waiting marker
 * comes down before the task exists. Unlike the context reads around it this
 * is not best-effort — a turn with no task row has nowhere to bill its model
 * call — so failures propagate.
 */
export async function chatTurnTask(
  db: Db | ApplicationChatPersistence,
  input: { agentId: string; conversationId: string; title: string; metadata?: unknown },
) {
  if ('kind' in db) {
    const goalId = goalIdFromConversation(input.metadata);
    if (goalId) await db.clearGoalBlockedOnOwnerReply(input.agentId, goalId);
    return db.createDirectChatTask({
      agentId: input.agentId,
      conversationId: input.conversationId,
      goalId,
      title: input.title,
    });
  }
  const goalId = await goalIdForConversation(db, input.conversationId);
  if (goalId) await clearGoalBlockedOnOwnerReply(db, goalId);
  return createChatTask(db, {
    agentId: input.agentId,
    conversationId: input.conversationId,
    goalId,
    title: input.title,
  });
}

export async function handleChatTurn(
  req: Request,
  dependencies: ChatTurnDependencies,
): Promise<Response> {
  const { config, router } = dependencies;
  const requireDb = (): Db => {
    if (!dependencies.db) throw new Error('Chat persistence is not configured');
    return dependencies.db;
  };
  const providerProblems = modelProviderConfigProblems(config);
  if (providerProblems.length > 0) {
    return Response.json(
      {
        error: `The model provider is not configured on this server: ${providerProblems.join('; ')}`,
        code: 'not_configured',
      },
      { status: 503 },
    );
  }

  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json(
      { error: 'That message is too large to send — trim it and try again.', code: 'too_large' },
      { status: 413 },
    );
  }
  const requestBody = await readBoundedBody(req, MAX_REQUEST_BYTES).catch(() => null);
  if (!requestBody) {
    return Response.json(
      { error: 'The request could not be read — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }
  if (!requestBody.ok) {
    return Response.json(
      { error: 'That message is too large to send — trim it and try again.', code: 'too_large' },
      { status: 413 },
    );
  }
  const rawBody = requestBody.text;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    return Response.json(
      { error: 'The request was malformed — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return Response.json(
      { error: 'The request was malformed — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }
  const body = parsedBody as {
    messages?: UIMessage[];
    conversationId?: string;
    autonomous?: boolean;
    force?: boolean;
    spoken?: boolean;
  };
  if (body.conversationId && !UUID_RE.test(body.conversationId)) {
    return Response.json(
      { error: 'The request was malformed — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }
  // The composer's "Autonomous" toggle. This POST is an authenticated owner
  // action (isAuthed above), so it is a valid grant-arming surface: the toggle
  // IS the approval, and the task runs free-range (subject to the dispatcher's
  // hard floor). A forced action request always runs through the executor.
  const autonomousRequested = body.autonomous === true;
  // "Run it for real" on an off-course reply: route around the classifier
  // without arming the autonomy grant — approvals still ask as usual.
  const forceRequested = body.force === true;
  // The phone's talk mode: this reply will be read out loud, so it is written
  // for the ear. Nothing else about the turn changes.
  const spokenRequested = body.spoken === true;
  const uiMessages = body.messages ?? [];
  if (!Array.isArray(uiMessages)) {
    return Response.json(
      { error: 'The request was malformed — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }
  const userMessage = [...uiMessages]
    .reverse()
    .find(
      (message): message is UIMessage =>
        Boolean(message) && typeof message === 'object' && message.role === 'user',
    );
  if (!userMessage || !Array.isArray(userMessage.parts)) {
    return Response.json(
      { error: 'The request was malformed — try sending again.', code: 'bad_request' },
      { status: 400 },
    );
  }

  const userText = textOf(userMessage).trim();
  if (!userText) {
    return Response.json(
      { error: 'Type a message first, then send.', code: 'bad_request' },
      { status: 400 },
    );
  }
  if (byteLength(userText) > MAX_USER_MESSAGE_BYTES) {
    return Response.json(
      { error: 'That message is too large to send — trim it and try again.', code: 'too_large' },
      { status: 413 },
    );
  }

  const chat = dependencies.chat ?? createPostgresApplicationChatPersistence(requireDb());
  const agent = await chat.resolveAgent();
  const existingConversation = body.conversationId
    ? await chat.getConversation(agent.id, body.conversationId)
    : null;
  if (body.conversationId && !existingConversation) {
    return Response.json(
      {
        error:
          'This chat is no longer available. Open an existing chat or start a new one before sending.',
        code: 'conversation_unavailable',
      },
      { status: 404 },
    );
  }
  const conversation = existingConversation ?? (await chat.createConversation(agent.id));

  // Replying is an explicit choice to resume an archived chat. Preserve the
  // history, but make it visible again instead of creating a duplicate thread.
  if (conversation.archivedAt) {
    await chat.restoreConversation(agent.id, conversation.id);
    conversation.archivedAt = null;
  }

  if (!conversation.title) {
    await chat.setConversationTitleIfEmpty(agent.id, conversation.id, userText.slice(0, 60));
    conversation.title = userText.slice(0, 60);
  }

  const persistedUser = await chat.appendOwned(agent.id, {
    conversationId: conversation.id,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: userText }],
    text: userText,
  });
  if (!persistedUser) throw new Error('failed to persist chat message');
  const messageCursor = encodeMessageCursor(persistedUser);
  const refreshCardId = savedCardRefreshId(userText);
  const cardRefresh = dependencies.db ?? dependencies.persistence?.cardRefresh;
  if (refreshCardId && cardRefresh) {
    const result = await requestSavedCardRefresh(
      cardRefresh,
      agent.id,
      refreshCardId,
      conversation.id,
    );
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return acceptedStreamResponse(result.taskId, {
      'x-conversation-id': conversation.id,
      'x-async-task': result.taskId,
      'x-message-cursor': messageCursor,
    });
  }
  const historyPage = await chat.listMessages(agent.id, conversation.id, {
    limit: MODEL_HISTORY_LIMIT,
  });
  if (!historyPage) throw new Error('chat not found');
  const historyRows = historyPage.messages;
  const noticeRows = await applicationBackgroundNoticeIds(chat, agent.id, historyRows);
  const modelHistory = boundedModelHistory(historyRows, noticeRows);
  if (config.SELF_REPAIR_ENABLED && isRepairFeedback(userText)) {
    const original = [...historyRows]
      .reverse()
      .find((row) => row.role === 'assistant' && row.taskId && !noticeRows.has(row.id));
    const repairs =
      dependencies.persistence?.selfRepair ??
      (dependencies.db ? createPostgresSelfRepairRepository(dependencies.db) : null);
    if (repairs) {
      await reportRepair(repairs, agent.id, {
        source: 'feedback',
        key: original?.taskId ?? persistedUser.id,
        sourceTaskId: original?.taskId ?? undefined,
        conversationId: conversation.id,
        title: 'Owner reported incorrect assistant behavior',
        summary: userText,
      }).catch((err) => console.error('Could not capture improvement feedback', err));
    }
  }
  if (isApprovalReply(userText)) {
    const replyTask = await chat.createDirectChatTask({
      agentId: agent.id,
      conversationId: conversation.id,
      title: userText,
    });

    const previous = historyRows.slice(0, -1).at(-1);
    const target =
      previous?.role === 'assistant' ? budgetReplyTarget(userText, previous) : undefined;
    let responseText =
      'I could not match this approval to one pending budget request. Open the specific approval card to apply the decision; no change has been made by this reply.';
    if (target) {
      try {
        await chat.raiseTaskBudget(agent.id, target.taskId, target.amount);
        responseText = `Approved the spending limit of $${target.amount.toFixed(2)} and queued that task to resume.`;
      } catch {
        responseText =
          'That budget request could not be applied. It may already be resolved or the task may no longer be waiting. Check its current state in Activity.';
      }
    }
    await finishApplicationChatTask(chat, agent.id, replyTask, { status: 'done', responseText });
    return acceptedStreamResponse(replyTask.id, {
      'x-conversation-id': conversation.id,
      'x-async-task': replyTask.id,
      'x-message-cursor': messageCursor,
    });
  }

  // Triage: conversation streams below; action requests go to the executor.
  // On triage failure default to the executor — a slow honest answer beats a
  // fast hallucinated one.
  let needsAction = true;
  // Whether anything actually *concluded* "action", as opposed to the default
  // above standing because triage could not answer. Only a real ruling travels
  // to the executor (see TRIAGED_ACTIONABLE), because only a real ruling is
  // worth letting the planner skip its own version of this question.
  let ruledOnAction = false;
  // A deterministic gate first: a clear imperative ("add lunch Friday noon")
  // must reach the tools path even when the cheap classify model misreads it as
  // conversation. Failed-action follow-ups also return to the executor when
  // the preceding assistant turn committed to an action. Only the genuinely
  // ambiguous rest falls through to the model.
  // A notice is not the assistant committing to an action, so it must not be
  // what a failed-action follow-up is judged against.
  const priorAssistantText = [...modelHistory.slice(0, -1)]
    .reverse()
    .find((message) => message.role === 'assistant' && !noticeRows.has(message.id));
  if (
    autonomousRequested ||
    forceRequested ||
    isSituationRequest(userText) ||
    looksLikeActionRequest(
      userText,
      priorAssistantText ? textOf(priorAssistantText) : '',
      modelHistory.slice(0, -1).filter((message) => !noticeRows.has(message.id)),
    )
  ) {
    // A free-range request must run through the executor (which honors the grant
    // and its floor) — never the tool-less streaming path.
    needsAction = true;
    ruledOnAction = true;
  } else {
    try {
      // Prior turns are context only; the latest message is what we classify.
      // Passing them mixed together let the model judge the whole thread (a
      // finished task in the history read as "nothing to do").
      const context = modelHistory
        .slice(-6, -1)
        .map((m) => `${m.role}: ${textOf(m).slice(0, 500)}`)
        .join('\n');
      const triage = await router.object<z.infer<typeof NeedsActionSchema>>('classify', {
        schema: NeedsActionSchema,
        system:
          'Route one chat turn. Decide whether the LATEST user message asks the assistant to DO or CHECK something (send/schedule/book/buy/browse, read, summarize, or report on the inbox or calendar — "look at my calendar and tell me…", "what do I have this week" — remember something, set a reminder, run a task) versus plain conversation. Judge ONLY the latest message; earlier turns are context. When uncertain, choose action — this streaming path has no tools and cannot act on the message.',
        prompt: context
          ? `Prior turns (context only):\n${context}\n\nLATEST USER MESSAGE (classify this):\n${userText}`
          : `LATEST USER MESSAGE (classify this):\n${userText}`,
      });
      if (triage.ok) {
        needsAction = triage.object.needsAction;
        ruledOnAction = true;
      }
    } catch (err) {
      console.error('chat triage failed — routing to executor', err);
    }
  }

  if (needsAction) {
    // Fail before creating a task when the deployed queue cannot authenticate
    // to the agent. Previously this threw from getQueueNotifier and surfaced as
    // an opaque 500, most often on a second turn that was action-routed.
    if (
      config.QUEUE_DRIVER === 'cloudtasks' &&
      (!config.INTERNAL_OIDC_AUDIENCE || !config.INTERNAL_OIDC_SERVICE_ACCOUNT)
    ) {
      console.error('chat action queue is missing its OIDC configuration');
      return Response.json(
        {
          error:
            'The task service is temporarily unavailable. Your message was saved — try again in a moment.',
          code: 'queue_unavailable',
        },
        { status: 503 },
      );
    }
    // The executor persists its answer (or an approval notice) into this
    // conversation; the client polls /api/chat/status until it lands.
    try {
      // An answer typed into a goal's work chat belongs to that goal, so the
      // goal's own sessions can see it was answered — and it answers whatever
      // question had the goal blocked, so the waiting marker comes down now.
      const goalId = goalIdFromConversation(conversation.metadata);
      if (goalId) await chat.clearGoalBlockedOnOwnerReply(agent.id, goalId);
      const { task } = await enqueueTask(dependencies.persistence?.tasks ?? requireDb(), {
        event: {
          source: 'chat',
          agentId: agent.id,
          conversationId: conversation.id,
          trust: 'owner',
          payload: { text: userText, ...(ruledOnAction ? { [TRIAGED_ACTIONABLE]: true } : {}) },
        },
        type: 'chat_turn',
        goalId,
        ...(autonomousRequested
          ? {
              autonomyGrant: buildAutonomyGrant({
                grantedVia: 'composer',
                nowMs: Date.now(),
              }),
            }
          : {}),
      });
      return acceptedStreamResponse(task.id, {
        'x-conversation-id': conversation.id,
        'x-async-task': task.id,
        'x-message-cursor': messageCursor,
      });
    } catch (error) {
      console.error('chat action task could not be queued', error);
      return Response.json(
        {
          error:
            'The task service is temporarily unavailable. Your message was saved — try again in a moment.',
          code: 'queue_unavailable',
        },
        { status: 503 },
      );
    }
  }

  // Long-running-chat auto-recall (Phase 1): reach back into the owner's own
  // earlier discussion that is relevant to this turn but has scrolled out of
  // the live window. Best-effort — a recall failure must never fail the chat.
  const recallPromise = (async (): Promise<{ block?: string; sources: RecallSource[] }> => {
    if (!config.CHAT_RECALL_ENABLED) return { sources: [] };
    try {
      const layered = await recallWithGraphFallback({
        graph: config.GRAPH_RAG_ENABLED
          ? async () => {
              const [queryEmbedding] = await router.embed([userText]);
              return {
                graph: await recallKnowledgeGraph(dependencies.persistence?.graph ?? requireDb(), {
                  agentId: agent.id,
                  queryText: userText,
                  queryEmbedding,
                }),
                queryEmbedding,
              };
            }
          : undefined,
        history: (queryEmbedding, graph) =>
          recallRelevantContext(
            dependencies.persistence?.history ?? requireDb(),
            {
              agentId: agent.id,
              queryText: userText,
              embed: (values, embedOpts) => router.embed(values, embedOpts ?? {}),
              exclude: {
                conversationId: conversation.id,
                sinceCreatedAt: historyRows[0]?.createdAt ?? persistedUser.createdAt,
              },
            },
            {
              ...(graph.used > 0 ? { maxChars: 1200 } : {}),
              queryEmbedding,
            },
          ),
        onGraphError: (err) => {
          // GraphRAG is additive. Existing vector recall must still answer when
          // graph storage, extraction, or its query embedding is unavailable.
          console.error('knowledge graph recall failed — falling back to chat recall', err);
        },
        onHistoryError: (err) => {
          console.error(
            'chat history recall failed — continuing with graph evidence if available',
            err,
          );
        },
      });
      void recordRecallMetric(dependencies.persistence?.recallMetrics ?? requireDb(), {
        agentId: agent.id,
        conversationId: conversation.id,
        path: 'chat',
        graphAttempted: config.GRAPH_RAG_ENABLED,
        graphFailed: layered.graphFailed,
        graphCandidates: layered.graph.candidates,
        graphUsed: layered.graph.used,
        historyFailed: layered.historyFailed,
        historyTier: layered.history.tier ?? 'none',
        historyUsed: layered.history.used ?? layered.history.sources.length,
        sourceCount: layered.sources.length,
      }).catch((err) => console.error('chat recall metric failed', err));
      return { block: layered.block || undefined, sources: layered.sources };
    } catch (err) {
      console.error('chat recall failed — continuing without it', err);
      return { sources: [] };
    }
  })();

  const taskPromise = chatTurnTask(chat, {
    agentId: agent.id,
    conversationId: conversation.id,
    title: userText,
    metadata: conversation.metadata,
  });
  // Context reads are independent. Only evidence needs the newly created task ID.
  const [recall, openLoops, task, evidence, ambientBlock, ownerCard] = await Promise.all([
    recallPromise,
    openLoopContext(dependencies.persistence?.ownerContext ?? requireDb(), agent.id, userText),
    taskPromise,
    taskPromise.then((created) =>
      chat.listConversationEvidence(agent.id, conversation.id, created.id),
    ),
    getAmbientBlock(dependencies.persistence?.ownerContext ?? requireDb(), agent.id).catch(
      (err) => {
        console.error('ambient context failed — continuing without it', err);
        return undefined;
      },
    ),
    getOwnerCard(dependencies.persistence?.ownerContext ?? requireDb(), agent.id).catch((err) => {
      console.error('owner context failed — continuing without it', err);
      return undefined;
    }),
  ]);
  const recallBlock = recall.block;
  const recallSources = recall.sources;
  // Honesty-check scope for guardDraft: everything earlier turns actually did,
  // all marked prior-turn. This turn itself runs no tools.
  const toolEvidence = evidence.map((row) => ({ ...row, fromCurrentTask: false }));
  const readRequest = detectPersonalReadRequest(modelHistory);
  // Corpus for the URL-provenance rule, mirroring finalize.ts: every tool
  // result, plus everything else the turn legitimately saw — the owner's own
  // words, the recalled context, the ambient block. Deliberately NOT the
  // assistant's own turns, which must never evidence their own link.
  const urlCorpus = [
    JSON.stringify(toolEvidence),
    modelHistory
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.parts ?? message))
      .join('\n'),
    recallBlock ?? '',
    ambientBlock ?? '',
  ].join('\n');
  // The contract is not cheap — it stringifies the whole ledger and runs the
  // full matcher set — and both the completion callback and the stream pump
  // need the same verdict for the same draft. Compute it once.
  const guardCache = new Map<string, { corrected: boolean; text: string }>();
  const guardOnce = (draft: string) => {
    const cached = guardCache.get(draft);
    if (cached) return cached;
    const result = guardDraft(draft, toolEvidence, {
      readRequest,
      urlCorpus,
      requestText: userText,
    });
    guardCache.set(draft, result);
    return result;
  };

  let outcome: StreamOutcome;
  try {
    outcome = await router.stream('draft', {
      taskId: task.id,
      // owner chat is the critical carve-out: degrade on a hard cap, don't block
      critical: true,
      modelOverride: conversation.modelOverride ?? undefined,
      // The conversation row is already in hand, so its override column is
      // authoritative here; without this the router re-reads it through a
      // tasks↔conversations join for a value this turn just passed in.
      modelOverrideResolved: true,
      system: [
        buildSystemPrompt(agent, {
          ownerCard,
          recall: recallBlock,
          openLoops,
          ambient: ambientBlock,
          channel: 'dashboard-chat',
        }),
        '',
        'This turn is conversational: just answer. You have no tools in this turn, so if the user is actually asking you to take an action, say plainly that you cannot do it in this reply and ask them to restate it as a direct request. Otherwise do not mention tools, capabilities, or this instruction at all — no postscripts.',
        ...(spokenRequested ? spokenReplyLines() : []),
      ].join('\n'),
      messages: await convertToModelMessages(modelHistory),
      onComplete: async (text) => {
        // Strip the companion cue tags BEFORE the guard, for the same reason
        // the pump strips them below: the contract's prose matchers must see
        // clean text, and the persisted reply must be byte-identical to the
        // streamed one (retireProvisionalReplies dedupes on exact text).
        const stripped = stripCueTags(text);
        // An empty completion is a failed turn, not a blank bubble.
        if (stripped.text.trim() === '') {
          console.warn('model returned an empty chat reply', { taskId: task.id });
          await finishApplicationChatTask(chat, agent.id, task, {
            status: 'failed',
            progress: 'model returned an empty reply',
            failureNotice: { text: TURN_FAILURE_COPY.empty, reason: 'empty' },
          });
          return;
        }
        const guarded = guardOnce(stripped.text);
        if (guarded.corrected) {
          console.warn('tool-less chat draft claimed unperformed work', {
            taskId: task.id,
          });
        }
        await finishApplicationChatTask(chat, agent.id, task, {
          status: 'done',
          // Persist the contract-owned replacement, never the unsupported
          // draft. The stream pump below sends the client this same text, so
          // the live reply and the durable one stay identical — which is what
          // retireProvisionalReplies matches on to retire the local copy.
          responseText: guarded.text,
          recall: recallSources,
          cues: guarded.corrected ? undefined : stripped.cues,
          offCourse: guarded.corrected,
        });
      },
      onError: async (error) => {
        await finishApplicationChatTask(chat, agent.id, task, {
          status: 'failed',
          progress: String(error).slice(0, 500),
          failureNotice: { text: TURN_FAILURE_COPY.model, reason: 'model' },
        });
      },
    });
  } catch (error) {
    await finishApplicationChatTask(chat, agent.id, task, {
      status: 'failed',
      progress: String(error).slice(0, 500),
      failureNotice: { text: TURN_FAILURE_COPY.model, reason: 'model' },
    });
    return Response.json(
      {
        error:
          'The model service failed to answer. Your message was saved — try again in a moment.',
        code: 'model_unavailable',
      },
      { status: 502 },
    );
  }

  if (!outcome.ok) {
    await finishApplicationChatTask(chat, agent.id, task, {
      status: 'failed',
      progress: outcome.decision.reason,
      failureNotice: { text: TURN_FAILURE_COPY.budget, reason: 'budget' },
    });
    return Response.json(
      {
        error: `Your spending cap stopped this reply (${outcome.decision.reason}). Raise the cap on the Costs page, then try again.`,
        code: 'budget_exhausted',
        mode: outcome.decision.mode,
      },
      { status: 402 },
    );
  }

  // Stream the draft as-is, then run the honesty check on the finished text.
  // The deltas have already reached the client, so a flagged draft cannot be
  // un-sent — but it must not be what the reader is left holding either. The
  // marker part carries the contract's replacement, and the chat renders that
  // in place of the draft, matching what onComplete persisted. Keeping the two
  // byte-identical is load-bearing: retireProvisionalReplies retires the local
  // copy by comparing its text against the server's, so a divergence here
  // leaves the draft and its replacement stacked in the log until a reload.
  const okOutcome = outcome;
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Pump the model stream by hand (not writer.merge, whose pump can race a
      // direct write) and hold the finish part back, so the marker — when
      // needed — still lands inside the message, not after the client saw it end.
      // The pump also strips companion cue tags from the text deltas and
      // re-emits them as data-* parts, so the face reacts mid-stream while the
      // streamed text stays byte-identical to what onComplete persists.
      const parts = okOutcome.toUIMessageStream({ sendFinish: false });
      await pumpWithCues(
        parts as unknown as AsyncIterable<StreamChunk>,
        (chunk) => writer.write(chunk as Parameters<typeof writer.write>[0]),
        createCueScanner(),
      );
      const guarded = guardOnce(stripCueTags(await okOutcome.text).text);
      if (guarded.corrected) {
        writer.write({ type: 'data-off-course', data: { text: guarded.text } });
      }
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-model-id': outcome.modelId,
      'x-model-degraded': String(outcome.degraded),
      'x-conversation-id': conversation.id,
      'x-message-cursor': messageCursor,
      // Live transparency for this streaming turn; the persisted `recall`
      // message part carries the same provenance across reloads.
      ...(recallSources.length > 0 ? { 'x-recall': encodeRecallHeader(recallSources) } : {}),
    },
  });
}
