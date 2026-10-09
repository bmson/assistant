import { suggestionExpiresAt } from '@assistant/core';
import { approvalRule } from '@assistant/core/approval-rule';
import { decodeMessageCursor, encodeMessageCursor } from '@assistant/core/chat';
import { compactChatMessageParts, stripBackgroundNoticeEcho } from '@assistant/core/chat-card';
import { approvalHeadline, truncateAtBoundary } from '@assistant/core/owner-text';
import {
  createPostgresApplicationChatPersistence,
  createPostgresGeneratedCardRepository,
  type Db,
} from '@assistant/db';
import type {
  ApplicationChatMessage,
  ApplicationChatPersistence,
  ChatTurnCancellationResult,
  GeneratedCardRepository,
} from '@assistant/persistence';
import type { UIMessage } from 'ai';
import { listSavedCards } from './cards.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
/** A task in one of these is not going to produce more output on its own. */
export const SETTLED_TASK_STATUSES = new Set([
  ...TERMINAL_TASK_STATUSES,
  'needs_attention',
  'waiting_approval',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cap on how many on-screen decision cards one poll may re-read. */
const MAX_REFRESH_IDS = 10;

/** How stale the read stamp must be before opening a thread rewrites it. */
const READ_STAMP_SETTLE_SECONDS = 30;

export type InlineApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';
export interface InlineApprovalDetail {
  label: string;
  value: string;
}

interface ApprovalPart {
  type: 'approval';
  approvalId: string;
  status?: InlineApprovalStatus;
}

interface BudgetRequestPart {
  type: 'budget-request';
  taskId: string;
  proposedBudgetUsd: number;
  status?: 'pending' | 'approved' | 'denied' | 'missing';
}

function isApprovalPart(part: unknown): part is ApprovalPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval' &&
    typeof (part as { approvalId?: unknown }).approvalId === 'string'
  );
}

function isBudgetRequestPart(part: unknown): part is BudgetRequestPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'budget-request' &&
    typeof (part as { taskId?: unknown }).taskId === 'string' &&
    typeof (part as { proposedBudgetUsd?: unknown }).proposedBudgetUsd === 'number'
  );
}

function isSuggestionPart(part: unknown): part is { type: 'suggestion'; suggestionId: string } {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'suggestion' &&
    typeof (part as { suggestionId?: unknown }).suggestionId === 'string'
  );
}

/**
 * The dashboard mirror of a parked task's approvals. Unlike an `approval` part
 * it names no single approval, so it used to be the one decision card with no
 * live state at all: it kept saying "1 action is waiting for review" long after
 * the owner had answered on the Approvals page. `approvalIds` is what makes it
 * hydratable; rows written before it fall back to the message's own task.
 */
interface ApprovalSummaryPart {
  type: 'approval-summary';
  purpose: string;
  approvalCount: number;
  approvalIds?: string[];
}

function isApprovalSummaryPart(part: unknown): part is ApprovalSummaryPart {
  return (
    Boolean(part) &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'approval-summary' &&
    typeof (part as { purpose?: unknown }).purpose === 'string'
  );
}

function summaryApprovalIds(part: ApprovalSummaryPart): string[] {
  return Array.isArray(part.approvalIds)
    ? part.approvalIds.filter((id): id is string => typeof id === 'string')
    : [];
}

function messageTaskId(message: UIMessage): string | undefined {
  const taskId = (message.metadata as { taskId?: unknown } | undefined)?.taskId;
  return typeof taskId === 'string' ? taskId : undefined;
}

function detailLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : 'Value';
}

function detailValue(value: unknown): string {
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '(not set)';
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object')) {
    return value.map(String).join(', ') || '(none)';
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * Persisted rows as the chat client reads them. `createdAt` travels on metadata
 * because it is what orders the rendered log — see orderChatLog in the web app.
 * Accepts the base row shape: listMessages rows carry an extra microsecond
 * cursor column that UI mapping has no use for.
 */
type PersistedMessage = ApplicationChatMessage;

export type ChatStore =
  | Db
  | ApplicationChatPersistence
  | { chat: ApplicationChatPersistence; generatedCards: GeneratedCardRepository };

function chatPersistence(store: ChatStore): ApplicationChatPersistence {
  if ('chat' in store) return store.chat;
  return 'kind' in store && store.kind === 'application-chat-persistence'
    ? store
    : createPostgresApplicationChatPersistence(store as Db);
}

function cardPersistence(store: ChatStore): GeneratedCardRepository | undefined {
  if ('chat' in store) return store.generatedCards;
  if ('kind' in store && store.kind === 'application-chat-persistence') return undefined;
  return createPostgresGeneratedCardRepository(store as Db);
}

function persistedParts(row: PersistedMessage): unknown[] {
  return Array.isArray(row.parts) ? row.parts : [];
}

function hasPart(row: PersistedMessage, type: string): boolean {
  return persistedParts(row).some(
    (part) =>
      Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === type,
  );
}

function noticeMarker(row: PersistedMessage): string | undefined {
  for (const part of persistedParts(row)) {
    if (!part || typeof part !== 'object') continue;
    const value = part as { type?: unknown; notice?: unknown };
    if (value.type === 'notice' && typeof value.notice === 'string') return value.notice;
  }
  return undefined;
}

function approvalIds(row: PersistedMessage): string[] {
  return persistedParts(row)
    .filter(isApprovalPart)
    .map((part) => part.approvalId)
    .sort();
}

/** The dashboard approval nudge, recognisable by its prose shape alone. */
function isApprovalNudgeText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('Something needs your approval:') ||
    /^\d+ things need your approval:/u.test(trimmed) ||
    trimmed.startsWith('Approval needed to continue:')
  );
}

const NEEDS_ATTENTION_PREFIXES = [
  "I couldn't complete this after repeated attempts and stopped.",
  'A task stopped and needs you',
];

/**
 * The runtime state family one row belongs to, keyed by its task, or
 * undefined for ordinary conversation. Rows in a family are projections of
 * the SAME task state, so only the richest, newest one may stay visible.
 */
function runtimeStateFamily(row: PersistedMessage): string | undefined {
  if (!row.taskId || row.role !== 'assistant') return undefined;
  const approvalsInRow = approvalIds(row);
  const marker = noticeMarker(row);
  const text = row.text.trim();
  let family: string | undefined;
  if (hasPart(row, 'approval-summary')) family = 'approval-summary';
  else if (approvalsInRow.length > 0) family = `approval:${approvalsInRow.join(',')}`;
  else if (hasPart(row, 'budget-request')) family = 'budget-request';
  else if (marker === 'parked' || marker === 'needs-attention') family = marker;
  else if (NEEDS_ATTENTION_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    family = 'needs-attention';
  }
  return family ? `${row.taskId}:${family}` : undefined;
}

/**
 * Runtime notices are state projections, not separate conversational turns.
 * Older workers could write one into the task's thread and then mirror a
 * second prose copy into that same primary thread. A crash between write and
 * stamp could also re-emit the same task state. Keep the richest, newest row
 * for each runtime state family while leaving ordinary repeated conversation
 * untouched.
 */
export function collapseRuntimeMessageDuplicates<T extends PersistedMessage>(rows: T[]): T[] {
  const structuredApprovalTasks = new Set(
    rows
      .filter((row) => row.taskId && (hasPart(row, 'approval') || hasPart(row, 'approval-summary')))
      .map((row) => row.taskId as string),
  );
  const dropped = new Set<string>();
  const families = new Map<string, T[]>();

  for (const row of rows) {
    if (!row.taskId || row.role !== 'assistant') continue;
    if (
      structuredApprovalTasks.has(row.taskId) &&
      !hasPart(row, 'approval-summary') &&
      isApprovalNudgeText(row.text)
    ) {
      dropped.add(row.id);
      continue;
    }

    const key = runtimeStateFamily(row);
    if (!key) continue;
    const group = families.get(key) ?? [];
    group.push(row);
    families.set(key, group);
  }

  const kept = new Set<string>();
  for (const group of families.values()) {
    // Prefer a structured state row over its dashboard prose mirror, then the
    // newest structured row when a later retry changed the details.
    const structured = group.filter(
      (row) =>
        noticeMarker(row) !== undefined ||
        hasPart(row, 'approval') ||
        hasPart(row, 'approval-summary') ||
        hasPart(row, 'budget-request'),
    );
    const candidates = structured.length > 0 ? structured : group;
    const winner = candidates.reduce((latest, row) =>
      row.createdAt > latest.createdAt ? row : latest,
    );
    kept.add(winner.id);
    for (const row of group) {
      if (row.id !== winner.id) dropped.add(row.id);
    }
  }

  return rows.filter((row) => !dropped.has(row.id) || kept.has(row.id));
}

/** Cap on how much task history one poll re-reads to catch stale on-screen rows. */
const MAX_RUNTIME_SIBLINGS = 200;

/**
 * Collapse one delivered page against the FULL runtime-state history of the
 * tasks it touches.
 *
 * Collapsing the page alone is not enough: the older twin of a state row was
 * delivered by an earlier tick and now sits behind the cursor, so a merge-by-id
 * client keeps showing it next to the newer row that replaced it — the
 * duplicate only disappears on the next full load. Re-reading the tasks'
 * assistant rows (indexed, and only when the page actually carries a state
 * row) lets one response both hide a just-arrived row whose card the client
 * already has AND name the already-delivered rows it supersedes.
 *
 * `visible` is the page after collapse; `superseded` names rows OUTSIDE the
 * page the client may be showing that should now come down. A superseded id
 * can also appear in this response's `refreshed` — the retraction wins.
 */
async function collapsePageWithTaskHistory(
  persistence: ApplicationChatPersistence,
  agentId: string,
  conversationId: string,
  page: PersistedMessage[],
): Promise<{ visible: PersistedMessage[]; superseded: string[] }> {
  const taskIds = new Set<string>();
  for (const row of page) {
    if (!row.taskId || row.role !== 'assistant') continue;
    if (runtimeStateFamily(row) !== undefined || isApprovalNudgeText(row.text)) {
      taskIds.add(row.taskId);
    }
  }
  if (taskIds.size === 0) return { visible: page, superseded: [] };

  const siblings =
    (await persistence.listRuntimeMessages(
      agentId,
      conversationId,
      [...taskIds],
      MAX_RUNTIME_SIBLINGS,
    )) ?? [];

  const siblingIds = new Set(siblings.map((row) => row.id));
  const union = [...siblings, ...page.filter((row) => !siblingIds.has(row.id))];
  const keptIds = new Set(collapseRuntimeMessageDuplicates(union).map((row) => row.id));
  const pageIds = new Set(page.map((row) => row.id));
  return {
    visible: page.filter((row) => keptIds.has(row.id)),
    superseded: union
      .filter((row) => !keptIds.has(row.id) && !pageIds.has(row.id))
      .map((row) => row.id),
  };
}

function toUiMessages(rows: PersistedMessage[]): UIMessage[] {
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: compactChatMessageParts(
        row.role === 'assistant' ? stripBackgroundNoticeEcho(row.text) : row.text,
        (Array.isArray(row.parts) ? row.parts : []).map((part) =>
          row.role === 'assistant' && part?.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: stripBackgroundNoticeEcho(part.text) }
            : part,
        ),
        row.taskId ?? undefined,
      ) as UIMessage['parts'],
      // `taskId` rides along so hydration can resolve an approval summary
      // written before the part carried its own approval ids — see
      // hydrateChatApprovals. The client reads only `createdAt`.
      metadata: {
        createdAt: row.createdAt.toISOString(),
        taskId: row.taskId ?? undefined,
        channelMessageId: row.channelMessageId ?? undefined,
      },
    }));
}

/** Attach live approval and budget state to persisted custom message parts. */
export async function hydrateChatApprovals(
  store: ChatStore,
  messages: UIMessage[],
  now: Date = new Date(),
): Promise<UIMessage[]> {
  const generatedIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).flatMap((part) => {
          const data = part as { type?: string; data?: { kind?: string; id?: string } } | null;
          return data?.type === 'data-card' &&
            data.data?.kind === 'generated-card' &&
            typeof data.data.id === 'string' &&
            UUID_RE.test(data.data.id)
            ? [data.data.id]
            : [];
        }),
      ),
    ),
  ];
  const generatedCardRepository = cardPersistence(store);
  if (generatedIds.length && generatedCardRepository) {
    const persistence = chatPersistence(store);
    const agent = await persistence.resolveAgent();
    const current = new Map(
      (await listSavedCards(generatedCardRepository, agent.id, generatedIds)).map((card) => [
        card.id,
        card,
      ]),
    );
    messages = messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        const candidate = part as unknown as { type: string; data?: Record<string, unknown> };
        const card =
          candidate.type === 'data-card' && candidate.data?.kind === 'generated-card'
            ? current.get(String(candidate.data.id))
            : undefined;
        if (!card) return part;
        return {
          ...candidate,
          data: {
            ...candidate.data,
            revisionId: card.revisionId,
            spec: card.spec,
            updatedAt: card.updatedAt.toISOString(),
            stale: card.stale,
            refreshState: card.refreshState,
            refreshTaskId: card.refreshTaskId,
            refreshError: card.refreshError,
          },
        } as unknown as typeof part;
      }),
    }));
  }
  const persistence = chatPersistence(store);
  const approvalIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isApprovalPart).map((part) => part.approvalId),
      ),
    ),
  ];
  const budgetTaskIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isBudgetRequestPart).map((part) => part.taskId),
      ),
    ),
  ];
  const suggestionIds = [
    ...new Set(
      messages.flatMap((message) =>
        (message.parts as unknown[]).filter(isSuggestionPart).map((part) => part.suggestionId),
      ),
    ),
  ];
  // A summary either names its approvals or, on a row written before it did,
  // stands for whatever its task is currently waiting on.
  const summaryIds = new Set<string>();
  const summaryTaskIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts as unknown[]) {
      if (!isApprovalSummaryPart(part)) continue;
      const ids = summaryApprovalIds(part);
      if (ids.length > 0) for (const id of ids) summaryIds.add(id);
      else {
        const taskId = messageTaskId(message);
        if (taskId) summaryTaskIds.add(taskId);
      }
    }
  }
  const lookupApprovalIds = [...new Set([...approvalIds, ...summaryIds])];
  if (
    !lookupApprovalIds.length &&
    !summaryTaskIds.size &&
    !budgetTaskIds.length &&
    !suggestionIds.length
  ) {
    return messages;
  }

  const agent = await persistence.resolveAgent();
  const hydration = await persistence.getHydrationState(agent.id, {
    approvalIds: lookupApprovalIds,
    approvalTaskIds: [...summaryTaskIds],
    budgetTaskIds,
    suggestionIds,
  });
  const approvalRows = hydration.approvals;
  const summaryTaskRows = hydration.taskApprovals;
  const budgetTasks = hydration.budgetTasks;
  const suggestionRows = hydration.suggestions;
  const suggestionById = new Map(suggestionRows.map((row) => [row.id, row]));
  const approvalById = new Map(approvalRows.map((row) => [row.id, row]));
  const taskById = new Map(budgetTasks.map((task) => [task.id, task]));
  const summaryByTask = new Map<string, typeof summaryTaskRows>();
  for (const row of summaryTaskRows) {
    summaryByTask.set(row.taskId, [...(summaryByTask.get(row.taskId) ?? []), row]);
  }
  /** An approval's state as the log should read it — pending lapses on time. */
  const settled = (row: { status: string; expiresAt: Date }): InlineApprovalStatus =>
    row.status === 'pending' && row.expiresAt <= now
      ? 'expired'
      : (row.status as InlineApprovalStatus);

  return messages.map((message) => ({
    ...message,
    parts: (message.parts as unknown[]).map((part) => {
      if (isApprovalSummaryPart(part)) {
        const ids = summaryApprovalIds(part);
        const taskId = messageTaskId(message);
        const rows = ids.length
          ? ids.flatMap((id) => {
              const row = approvalById.get(id);
              return row ? [row] : [];
            })
          : taskId
            ? (summaryByTask.get(taskId) ?? [])
            : [];
        // Nothing to resolve it against (a legacy row whose task is gone):
        // leave the persisted wording alone rather than claim it settled.
        if (rows.length === 0) return part;
        const outcomes = rows.map((row) => ({
          id: row.id,
          // The chat shows what is being asked in a few words; the full text is
          // on the Approvals page.
          summary: approvalHeadline(row.summary),
          status: settled(row),
        }));
        return {
          ...part,
          pendingCount: outcomes.filter((outcome) => outcome.status === 'pending').length,
          outcomes,
        };
      }
      if (isBudgetRequestPart(part)) {
        const task = taskById.get(part.taskId);
        const status = !task
          ? 'missing'
          : Number(task.budgetUsdLimit) >= part.proposedBudgetUsd
            ? 'approved'
            : task.status === 'cancelled'
              ? 'denied'
              : task.status === 'needs_attention'
                ? 'pending'
                : 'missing';
        return { ...part, status };
      }
      if (isSuggestionPart(part)) {
        const suggestion = suggestionById.get(part.suggestionId);
        if (!suggestion) return { ...part, status: 'missing' };
        // A suggestion nobody answered goes quiet on its own, so an elapsed
        // deadline reads as expired rather than as a live question.
        // A snooze is folded the same way: still sleeping reads as snoozed
        // (a settled receipt, not a live question), and a snooze whose time
        // has come reads as pending again so the card re-opens.
        const status =
          (suggestion.status === 'pending' || suggestion.status === 'snoozed') &&
          suggestionExpiresAt(suggestion) <= now
            ? 'expired'
            : suggestion.status === 'snoozed'
              ? suggestion.snoozedUntil && suggestion.snoozedUntil > now
                ? 'snoozed'
                : 'pending'
              : suggestion.status;
        return {
          ...part,
          status,
          acceptedTaskId: suggestion.acceptedTaskId ?? undefined,
          acceptedTaskStatus: suggestion.acceptedTaskStatus ?? undefined,
          // Legacy accepted tasks had no chat destination. Make their saved
          // completion update visible without rerunning the action.
          acceptedTaskSummary:
            suggestion.acceptedTaskStatus === 'done' && !suggestion.acceptedTaskConversationId
              ? truncateAtBoundary(suggestion.acceptedTaskProgress ?? '', 180) || undefined
              : undefined,
          snoozedUntil: suggestion.snoozedUntil?.toISOString(),
        };
      }
      if (!isApprovalPart(part)) return part;
      const approval = approvalById.get(part.approvalId);
      return approval
        ? {
            ...part,
            status:
              approval.status === 'pending' && approval.expiresAt <= now
                ? 'expired'
                : approval.status,
            rememberLabel:
              settled(approval) === 'pending'
                ? (approvalRule(approval.toolName ?? '', approval.payload)?.label ?? null)
                : null,
            details:
              approval.payload &&
              typeof approval.payload === 'object' &&
              !Array.isArray(approval.payload)
                ? Object.entries(approval.payload).map(([key, value]) => ({
                    label: detailLabel(key),
                    value: detailValue(value),
                  }))
                : [{ label: 'Value', value: detailValue(approval.payload) }],
          }
        : { ...part, status: 'missing', rememberLabel: null };
    }) as UIMessage['parts'],
  }));
}

export async function cancelChatTurn(
  store: ChatStore,
  input: { conversationId: string; clientOperationId: string },
): Promise<ChatTurnCancellationResult> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  return persistence.cancelChatTurn({
    agentId: agent.id,
    conversationId: input.conversationId,
    clientOperationId: input.clientOperationId,
  });
}

export async function createChatConversation(store: ChatStore): Promise<string> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  return (await persistence.createConversation(agent.id)).id;
}

export async function changeChatModel(
  store: ChatStore,
  conversationId: string,
  modelId: string | null,
): Promise<void> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  if (!(await persistence.setConversationModel(agent.id, conversationId, modelId))) {
    throw new Error('chat not found');
  }
}

export async function archiveChatConversation(
  store: ChatStore,
  conversationId: string,
): Promise<'archived' | 'active' | 'primary'> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  return persistence.archiveConversation(agent.id, conversationId);
}

export async function restoreChatConversation(
  store: ChatStore,
  conversationId: string,
): Promise<void> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  const conversation = await persistence.getConversation(agent.id, conversationId);
  if (!conversation) throw new Error('chat not found');
  await persistence.restoreConversation(agent.id, conversationId);
}

export async function hideChatMessage(
  store: ChatStore,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  if (!(await persistence.getConversation(agent.id, conversationId))) {
    throw new Error('chat not found');
  }
  return persistence.setMessageHidden(agent.id, conversationId, messageId, true);
}

export async function unhideChatMessage(
  store: ChatStore,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  if (!(await persistence.getConversation(agent.id, conversationId))) {
    throw new Error('chat not found');
  }
  return persistence.setMessageHidden(agent.id, conversationId, messageId, false);
}

export async function acknowledgeChatMessageDelivery(
  store: ChatStore,
  conversationId: string,
  messageId: string,
  clientId: string,
): Promise<boolean> {
  if (!UUID_RE.test(clientId)) return false;
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  if (!(await persistence.getConversation(agent.id, conversationId))) return false;
  return persistence.acknowledgeMessageDelivery(agent.id, conversationId, messageId, clientId);
}

export async function archiveInactiveChats(store: ChatStore, olderThanDays = 30): Promise<number> {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  return persistence.archiveInactiveConversations(agent.id, cutoff, 100);
}

export async function listChatHistory(store: ChatStore, archived: boolean) {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  const [page, archivedCount, totalInScope, activeConversationIds] = await Promise.all([
    persistence.listConversations(agent.id, { archived }),
    persistence.countConversations(agent.id, true),
    persistence.countConversations(agent.id, archived),
    persistence.listActiveConversationIds(agent.id),
  ]);
  return {
    conversations: page.conversations,
    archivedCount,
    totalInScope,
    activeConversationIds,
  };
}

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' && UUID_RE.test(goalId) ? goalId : undefined;
}

/** Validate the opaque chat polling cursor without exposing core encoding to transports. */
export function isValidChatCursor(value: string): boolean {
  return decodeMessageCursor(value) !== undefined;
}

export async function getChatConversationView(
  store: ChatStore,
  conversationId: string,
  input: { taskId?: string; cursor?: string; now?: Date },
) {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  const conversation = await persistence.getConversation(agent.id, conversationId);
  if (!conversation) return null;
  // Every load of this view is the owner opening the thread — the dashboard
  // page and both mobile reads funnel here — so it doubles as the read
  // cursor. The chat list marks a thread unread when activity lands after
  // this stamp. Best-effort: a failed stamp costs a dot, not the page.
  //
  // Only written when it would actually move. This is a read path that the
  // native app re-enters on every foreground and the web page on every load,
  // and an unconditional UPDATE put all of them in line behind each other for
  // the same row the executor is writing `updated_at` to. The unread dot is
  // about whether you have looked recently, not about the exact second.
  try {
    await persistence.markConversationRead(
      agent.id,
      conversation.id,
      input.now ?? new Date(),
      READ_STAMP_SETTLE_SECONDS,
    );
  } catch (err) {
    console.error('conversation read stamp failed', err);
  }
  const goalId = goalIdFromMetadata(conversation.metadata);
  const requestedTaskId = input.taskId && UUID_RE.test(input.taskId) ? input.taskId : undefined;
  const requestedCursor = decodeMessageCursor(input.cursor);
  const [messagePage, goalTitle, requestedTaskStatus, activeTaskCount, enabledModels] =
    await Promise.all([
      persistence.listMessages(agent.id, conversationId),
      goalId ? persistence.getGoalTitle(agent.id, goalId) : null,
      requestedTaskId ? persistence.getTaskStatus(agent.id, conversationId, requestedTaskId) : null,
      persistence.countActiveTasks(agent.id, conversationId),
      persistence.listEnabledModels(),
    ]);
  const messageRows = messagePage?.messages ?? [];
  const messages = await hydrateChatApprovals(
    store,
    toUiMessages(collapseRuntimeMessageDuplicates(messageRows)),
  );
  return {
    conversation,
    agentName: agent.name || 'Assistant',
    // Chat formats day dividers and times in this zone on BOTH sides, so the
    // server-rendered log and the hydrated one agree and nothing shifts once
    // the client takes over.
    agentTimezone: agent.timezone,
    messages,
    models: enabledModels,
    goalTitle: goalTitle ?? undefined,
    canArchive: !conversation.isPrimary && activeTaskCount === 0,
    // Where the open page resumes polling from. Without it the client has no
    // cursor until it sends a turn, so anything the assistant posted on its own
    // — a schedule, a watch, an approval resuming — stayed invisible until the
    // page was loaded again.
    //
    // Seeded under the same settle rule the poll advances by, because a render
    // is a poll like any other: a cursor planted on a row written moments ago
    // sits in front of whatever is still committing behind it, and the open
    // page never sees those at all. A chat whose every message is that fresh
    // starts with no cursor and picks one up on its first tick.
    cursor: advanceCursor(messageRows, undefined),
    asyncTurn:
      requestedTaskStatus && requestedTaskId && requestedCursor && input.cursor
        ? { taskId: requestedTaskId, cursor: input.cursor }
        : undefined,
  };
}

/**
 * Everything the open chat has not seen yet, from one cursor forward.
 *
 * `taskId` is optional because the chat log is not only fed by the turn you
 * just sent: schedules, missions, watches, attention notices and inbound
 * email/SMS all persist into the conversation with no task the page knows
 * about, and the executor keeps writing after a parked task resumes. Polling
 * only for a known task is what made those land invisibly until a reload.
 * With a task, the caller also gets its status and live tool activity.
 *
 * `refreshIds` names rows the caller is already showing and wants re-read —
 * decision cards whose live status may have changed elsewhere. They come back
 * in `refreshed`, deliberately NOT in `messages`: `messages` is what the client
 * uses to decide a turn has produced its answer, and a re-read of an old row is
 * not new output.
 *
 * `superseded` is the reverse direction: rows an earlier tick already
 * delivered that a row in THIS page replaces (a crash-retry re-emitting a task
 * state, a prose mirror superseded by its structured card). Collapsing one
 * page can never see those — the older twin sits behind the cursor — so the
 * page is collapsed against its tasks' full state history and the losers an
 * open client may be showing come back here for removal.
 */
export async function getChatUpdates(
  store: ChatStore,
  input: {
    conversationId: string;
    taskId?: string;
    cursor?: string;
    pageSize?: number;
    refreshIds?: string[];
    now?: Date;
  },
) {
  const persistence = chatPersistence(store);
  const agent = await persistence.resolveAgent();
  let taskStatus: string | null = null;
  if (input.taskId) {
    taskStatus = await persistence.getTaskStatus(agent.id, input.conversationId, input.taskId);
    if (taskStatus === null) return null;
  } else {
    // The task lookup above is what proved the caller may read this thread.
    // Without one, check the conversation itself rather than trusting an id
    // from the query string.
    if (!(await persistence.getConversation(agent.id, input.conversationId))) return null;
  }
  const cursor = decodeMessageCursor(input.cursor);
  const pageSize = input.pageSize ?? 50;
  const messagePage = await persistence.listMessages(agent.id, input.conversationId, {
    ...(cursor ? { after: cursor } : {}),
    ...(!cursor ? { fromStart: true } : {}),
    limit: pageSize,
  });
  if (!messagePage) return null;
  const hasMore = messagePage.hasMore;
  const page = messagePage.messages;
  const { visible, superseded } = await collapsePageWithTaskHistory(
    persistence,
    agent.id,
    input.conversationId,
    page,
  );
  const messages = await hydrateChatApprovals(store, toUiMessages(visible));
  const refreshIds = (input.refreshIds ?? [])
    .filter((id) => UUID_RE.test(id))
    .slice(0, MAX_REFRESH_IDS);
  const refreshed = refreshIds.length
    ? await hydrateChatApprovals(
        store,
        toUiMessages(
          (await persistence.listMessagesByIds(agent.id, input.conversationId, refreshIds)) ?? [],
        ),
      )
    : [];
  const nextCursor = advanceCursor(page, cursor);
  const taskId = input.taskId;
  const activity =
    taskId && taskStatus && !SETTLED_TASK_STATUSES.has(taskStatus)
      ? await persistence.listTaskActivity(agent.id, input.conversationId, taskId, 3)
      : [];
  return { taskStatus, messages, refreshed, superseded, nextCursor, hasMore, activity };
}

/**
 * How far the poll may remember having read. Never past a row young enough
 * that a slower transaction could still commit behind it (CURSOR_SETTLE_MS
 * above explains why that happens), and never backwards — the client loops
 * immediately while `hasMore` is set, so a cursor that could retreat would
 * spin. A full page means a real backlog, whose rows are old by definition, so
 * that case advances to the tail as before.
 */
function advanceCursor(
  page: ApplicationChatMessage[],
  cursor: { createdAt: Date; id: string; appendSequence?: string } | undefined,
): string | null {
  const fallback = cursor ? encodeMessageCursor(cursor) : null;
  if (page.length === 0) return fallback;
  const latestAppend = page
    .filter((row) => typeof row.appendSequence === 'string')
    .reduce<ApplicationChatMessage | undefined>(
      (latest, row) =>
        !latest ||
        (row.appendSequence ?? '') > (latest.appendSequence ?? '') ||
        ((row.appendSequence ?? '') === (latest.appendSequence ?? '') && row.id > latest.id)
          ? row
          : latest,
      undefined,
    );
  return latestAppend ? encodeMessageCursor(latestAppend) : fallback;
}
