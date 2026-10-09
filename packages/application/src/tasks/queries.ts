import { getAgent } from '@assistant/core/chat';
import { type AutonomyGrant, activeAutonomyGrant } from '@assistant/core/workflow/autonomy';
import {
  type RequestChecklist,
  RequestChecklistSchema,
} from '@assistant/core/workflow/request-checklist-schema';
import {
  approvals,
  type Db,
  files,
  messages,
  modelCalls,
  notChatAdmissionCancellationSql,
  tasks,
  toolCalls,
} from '@assistant/db';
import type {
  ActivityTaskRecord,
  TaskActivityDetailRepository,
  TaskActivityRepository,
} from '@assistant/persistence';
import {
  compareTimelineRows,
  decodeTaskTimelineCursor,
  encodeTaskTimelineCursor,
  type TaskTimelineKind,
  timelineTime,
} from '@assistant/persistence';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export const terminalTaskStatuses = ['done', 'failed', 'cancelled'] as const;
export type ActivityFilter = 'all' | 'needs-you' | 'working' | 'scheduled' | 'completed';

function statusesForFilter(filter: ActivityFilter): string[] | undefined {
  if (filter === 'needs-you') return ['waiting_approval', 'waiting_budget', 'needs_attention'];
  if (filter === 'working') return ['pending', 'running'];
  if (filter === 'scheduled') return ['sleeping', 'waiting_event'];
  if (filter === 'completed') return [...terminalTaskStatuses];
  return undefined;
}

export interface ActivityItem {
  id: string;
  type: string;
  status: string;
  title: string | null;
  progress: string;
  trust: string;
  spentUsd: string;
  budgetUsdLimit: string;
  updatedAt: Date;
  archivedAt: Date | null;
  hasPendingApproval: boolean;
  hasActiveAutonomy: boolean;
  stuckWaiting: boolean;
}

export interface ActivityList {
  items: ActivityItem[];
  archivedCount: number;
}

function activityItem(
  row: Omit<ActivityTaskRecord, 'agentId' | 'conversationId' | 'externalEventId' | 'trigger'>,
  pendingApprovalTaskIds: Set<string>,
): ActivityItem {
  const { autonomyGrant, ...task } = row;
  const hasPendingApproval = pendingApprovalTaskIds.has(task.id);
  return {
    ...task,
    hasPendingApproval,
    hasActiveAutonomy: activeAutonomyGrant({ ...task, autonomyGrant }, Date.now()) !== null,
    stuckWaiting: task.status === 'waiting_approval' && !hasPendingApproval,
  };
}

/** Portable owner Activity projection for a bounded persistence read. */
export async function listActivityWithRepository(
  repository: TaskActivityRepository,
  agentId: string,
  input: { archived: boolean; filter: ActivityFilter; limit?: number },
): Promise<ActivityList> {
  const { tasks, archivedCount, pendingApprovalTaskIds } = await repository.list(agentId, {
    archived: input.archived,
    statuses: statusesForFilter(input.filter),
    limit: input.limit ?? 50,
  });
  const pending = new Set(pendingApprovalTaskIds);
  return {
    items: tasks.map(
      ({
        agentId: _agentId,
        conversationId: _conversationId,
        externalEventId: _externalEventId,
        trigger: _trigger,
        ...task
      }) => activityItem(task, pending),
    ),
    archivedCount,
  };
}

/** Load the Activity list without exposing task or approval tables to the UI. */
export async function listActivity(
  db: Db,
  input: { archived: boolean; filter: ActivityFilter; limit?: number },
): Promise<ActivityList> {
  const agent = await getAgent(db);
  const statuses = statusesForFilter(input.filter);
  const [rows, archivedCountRows] = await Promise.all([
    db
      .select({
        id: tasks.id,
        type: tasks.type,
        status: tasks.status,
        title: tasks.title,
        progress: tasks.progress,
        trust: tasks.trust,
        spentUsd: tasks.spentUsd,
        budgetUsdLimit: tasks.budgetUsdLimit,
        updatedAt: tasks.updatedAt,
        archivedAt: tasks.archivedAt,
        autonomyGrant: tasks.autonomyGrant,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          notChatAdmissionCancellationSql(),
          sql`${tasks.trigger}->'payload'->>'canary' IS DISTINCT FROM 'true'`,
          input.archived ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt),
          statuses ? inArray(tasks.status, statuses) : undefined,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(input.limit ?? 50),
    db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          notChatAdmissionCancellationSql(),
          isNotNull(tasks.archivedAt),
        ),
      ),
  ]);

  const waitingIds = rows
    .filter((task) => task.status === 'waiting_approval')
    .map((task) => task.id);
  const pendingIds =
    waitingIds.length === 0
      ? []
      : await db
          .selectDistinct({ taskId: approvals.taskId })
          .from(approvals)
          .where(and(inArray(approvals.taskId, waitingIds), eq(approvals.status, 'pending')));
  const pendingApprovalTaskIds = new Set(pendingIds.map((row) => row.taskId));

  return {
    items: rows.map((task) => activityItem(task, pendingApprovalTaskIds)),
    archivedCount: Number(archivedCountRows[0]?.value ?? 0),
  };
}

export interface TaskSnapshot {
  id: string;
  type: string;
  status: string;
  title: string | null;
  trust: string;
  spentUsd: string;
  budgetUsdLimit: string;
  updatedAt: Date;
  deadline: Date | null;
  nextAction: string;
  progress: string;
  progressPercent: number | null;
  plan: RecordedValue | null;
  checklist?: Pick<RequestChecklist, 'items'>;
  archivedAt: Date | null;
}

/**
 * One JSON value out of the audit record, already rendered and already clipped.
 *
 * Tool results are persisted at whatever size the tool returned — a fetched
 * page, a workspace read, a browser step budgeted to 400KB — and the task
 * record used to hand every one of them to the page in full. A long mission
 * therefore rendered megabytes of collapsed `<details>`, all of it in the RSC
 * payload and the DOM whether or not anyone opened it. Serializing and
 * clipping here is what makes the page's weight a function of the page size
 * instead of a function of what the tools happened to return.
 */
export interface RecordedValue {
  /** Pretty-printed JSON (or the raw string), clipped to the budget. */
  text: string;
  /** Set when `text` is only the start of the value. */
  truncated: boolean;
  /** The full rendered length, so the page can say what is not being shown. */
  totalChars: number;
}

/** How much of one recorded value travels with a timeline entry. */
const MAX_RECORDED_CHARS = 4_000;
/** The same, for the action summary, which carries every call in the task. */
const MAX_PREVIEW_CHARS = 600;
/** How many timeline entries one page of the task record carries. */
export const TASK_TIMELINE_PAGE_SIZE = 100;
/** Owner-visible message text on the timeline is a one-line reminder, not the body. */
const MAX_TIMELINE_MESSAGE_CHARS = 200;

function record(value: unknown, budget: number): RecordedValue | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  return text.length <= budget
    ? { text, truncated: false, totalChars: text.length }
    : { text: text.slice(0, budget), truncated: true, totalChars: text.length };
}

/**
 * Whether a tool call actually did what it was asked.
 *
 * A `succeeded` status only means the adapter returned without throwing; a
 * provider can still answer "no" inside the payload. This is a rule about the
 * work, not about how it is displayed, so it lives here rather than in the
 * page that used to own it.
 */
function completedSuccessfully(status: string, result: unknown): boolean {
  if (status !== 'succeeded') return false;
  if (!result || typeof result !== 'object') return true;
  const payload = result as { ok?: unknown; status?: unknown; deliveryStatus?: unknown };
  return (
    payload.ok !== false &&
    !(typeof payload.status === 'number' && payload.status >= 400) &&
    payload.deliveryStatus !== 'unknown'
  );
}

export interface TaskToolCall {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  toolName: string;
  step: number;
  status: string;
  /** Pulled out of the decision JSON so the rest of it never travels. */
  riskTier: string | null;
  policyId: string | null;
  args: RecordedValue | null;
  result: RecordedValue | null;
  error: RecordedValue | null;
}

/**
 * One tool call as the "what actually happened" summary sees it. That section
 * reads the WHOLE task rather than the visible page, so this shape carries no
 * full payloads — only a preview, bounded per call.
 */
export interface TaskAction {
  id: string;
  toolName: string;
  createdAt: Date;
  finishedAt: Date | null;
  completed: boolean;
  error: string | null;
  resultPreview: RecordedValue | null;
}

export interface TaskModelCall {
  id: string;
  createdAt: Date;
  role: string;
  model: string;
  costUsd: string;
  latencyMs: number | null;
}

export interface TaskApproval {
  id: string;
  requestedAt: Date;
  status: string;
  summary: string;
  shortCode: string;
  resolvedVia: string | null;
  resolvedAt: Date | null;
}

export interface TaskMessage {
  id: string;
  createdAt: Date;
  role: string;
  text: string;
}

export interface TaskFile {
  id: string;
  workspacePath: string;
  bytes: number;
}

export interface TaskDetail {
  timezone: string;
  task: TaskSnapshot;
  toolCalls: TaskToolCall[];
  modelCalls: TaskModelCall[];
  approvals: TaskApproval[];
  messages: TaskMessage[];
  files: TaskFile[];
  /** Every tool call in the task, summarized — not just the visible page. */
  actions: TaskAction[];
  /** Older entries exist behind the oldest one on this page. */
  hasMoreTimeline: boolean;
  nextTimelineCursor?: string | null;
  activeGrant: AutonomyGrant | null;
  stuckWaiting: boolean;
}

/**
 * Load one page of the owner-visible audit record for a task.
 *
 * The timeline is four independent streams merged by time, so a page is taken
 * by fetching the newest `pageSize` of each and keeping the newest `pageSize`
 * of the union — which is exactly the newest `pageSize` overall. `before`
 * walks backwards from the oldest entry already shown.
 */
export async function getTaskDetail(
  db: Db,
  taskId: string,
  options: { pageSize?: number; before?: Date; cursor?: string } = {},
): Promise<TaskDetail | null> {
  const agent = await getAgent(db);
  const [task] = await db
    .select({
      id: tasks.id,
      type: tasks.type,
      status: tasks.status,
      title: tasks.title,
      trust: tasks.trust,
      spentUsd: tasks.spentUsd,
      budgetUsdLimit: tasks.budgetUsdLimit,
      updatedAt: tasks.updatedAt,
      deadline: tasks.deadline,
      nextAction: tasks.nextAction,
      progress: tasks.progress,
      progressPercent: tasks.progressPercent,
      plan: tasks.plan,
      checklist: sql<unknown>`${tasks.state}->'requestChecklist'`,
      archivedAt: tasks.archivedAt,
      autonomyGrant: tasks.autonomyGrant,
    })
    .from(tasks)
    .where(
      and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), notChatAdmissionCancellationSql()),
    );
  if (!task) return null;

  const pageSize = Math.max(
    1,
    Math.min(500, Math.floor(options.pageSize ?? TASK_TIMELINE_PAGE_SIZE)),
  );
  const before = options.before;
  const cursor = options.cursor ? decodeTaskTimelineCursor(options.cursor) : undefined;
  const olderThan = (column: PgColumn, id: PgColumn, kind: TaskTimelineKind) =>
    cursor
      ? sql`(${column}, ${kind}::text, ${id}::text) < (${cursor.at}::timestamptz, ${cursor.kind}::text, ${cursor.id}::text)`
      : before
        ? lt(column, before)
        : undefined;
  const preciseTime = (column: PgColumn) =>
    sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"000Z"')`;

  const [rawToolCalls, rawModelCalls, rawApprovals, rawMessages, taskFiles, actionRows] =
    await Promise.all([
      db
        .select({
          id: toolCalls.id,
          createdAt: toolCalls.createdAt,
          timelineAt: preciseTime(toolCalls.createdAt),
          finishedAt: toolCalls.finishedAt,
          toolName: toolCalls.toolName,
          step: toolCalls.step,
          status: toolCalls.status,
          decision: toolCalls.decision,
          args: toolCalls.args,
          result: toolCalls.result,
          error: toolCalls.error,
        })
        .from(toolCalls)
        .where(
          and(eq(toolCalls.taskId, taskId), olderThan(toolCalls.createdAt, toolCalls.id, 'tool')),
        )
        .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
        .limit(pageSize + 1),
      db
        .select({
          id: modelCalls.id,
          createdAt: modelCalls.createdAt,
          timelineAt: preciseTime(modelCalls.createdAt),
          role: modelCalls.role,
          model: modelCalls.model,
          costUsd: modelCalls.costUsd,
          latencyMs: modelCalls.latencyMs,
        })
        .from(modelCalls)
        .where(
          and(
            eq(modelCalls.taskId, taskId),
            olderThan(modelCalls.createdAt, modelCalls.id, 'model'),
          ),
        )
        .orderBy(desc(modelCalls.createdAt), desc(modelCalls.id))
        .limit(pageSize + 1),
      db
        .select({
          id: approvals.id,
          requestedAt: approvals.requestedAt,
          timelineAt: preciseTime(approvals.requestedAt),
          status: approvals.status,
          summary: approvals.summary,
          shortCode: approvals.shortCode,
          resolvedVia: approvals.resolvedVia,
          resolvedAt: approvals.resolvedAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.taskId, taskId),
            olderThan(approvals.requestedAt, approvals.id, 'approval'),
          ),
        )
        .orderBy(desc(approvals.requestedAt), desc(approvals.id))
        .limit(pageSize + 1),
      db
        .select({
          id: messages.id,
          createdAt: messages.createdAt,
          timelineAt: preciseTime(messages.createdAt),
          role: messages.role,
          text: messages.text,
        })
        .from(messages)
        .where(
          and(eq(messages.taskId, taskId), olderThan(messages.createdAt, messages.id, 'message')),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(pageSize + 1),
      db
        .select({ id: files.id, workspacePath: files.workspacePath, bytes: files.bytes })
        .from(files)
        .where(eq(files.taskId, taskId))
        .orderBy(asc(files.createdAt)),
      // The action summary reads every call in the task, so it deliberately
      // selects no `args` and only enough of `result` to judge the outcome.
      db
        .select({
          id: toolCalls.id,
          createdAt: toolCalls.createdAt,
          finishedAt: toolCalls.finishedAt,
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          result: toolCalls.result,
          error: toolCalls.error,
        })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(asc(toolCalls.step)),
    ]);

  // Newest `pageSize` of the union, then back into reading order.
  const page = timelinePage(rawToolCalls, rawModelCalls, rawApprovals, rawMessages, pageSize);
  const { hasMoreTimeline, nextTimelineCursor, onPage } = page;

  const decisionOf = (value: unknown) =>
    (value ?? {}) as { riskTier?: unknown; policyId?: unknown };

  const { autonomyGrant, plan, checklist, ...rest } = task;
  const parsedChecklist = RequestChecklistSchema.safeParse(checklist);
  const snapshot: TaskSnapshot = {
    ...rest,
    plan: record(plan, MAX_RECORDED_CHARS),
    ...(parsedChecklist.success ? { checklist: { items: parsedChecklist.data.items } } : {}),
  };
  const taskApprovals = rawApprovals.filter((row) => onPage('approval', row.id)).reverse();
  // A parked task whose approval is gone is stuck. The page carries only one
  // page of approvals now, so ask the table rather than the page.
  const stuckWaiting =
    task.status === 'waiting_approval' && !(await hasPendingApproval(db, taskId));
  return {
    timezone: agent.timezone,
    task: snapshot,
    toolCalls: rawToolCalls
      .filter((row) => onPage('tool', row.id))
      .reverse()
      .map((row) => {
        const decision = decisionOf(row.decision);
        return {
          id: row.id,
          createdAt: row.createdAt,
          finishedAt: row.finishedAt,
          toolName: row.toolName,
          step: row.step,
          status: row.status,
          riskTier: typeof decision.riskTier === 'string' ? decision.riskTier : null,
          policyId: typeof decision.policyId === 'string' ? decision.policyId : null,
          args: record(row.args, MAX_RECORDED_CHARS),
          result: record(row.result, MAX_RECORDED_CHARS),
          error: record(row.error, MAX_RECORDED_CHARS),
        };
      }),
    modelCalls: rawModelCalls.filter((row) => onPage('model', row.id)).reverse(),
    approvals: taskApprovals,
    messages: rawMessages
      .filter((row) => onPage('message', row.id))
      .reverse()
      .map((row) => ({
        ...row,
        text:
          row.text.length > MAX_TIMELINE_MESSAGE_CHARS
            ? `${row.text.slice(0, MAX_TIMELINE_MESSAGE_CHARS)}…`
            : row.text,
      })),
    files: taskFiles,
    actions: actionRows.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      completed: completedSuccessfully(row.status, row.result),
      error: row.error,
      resultPreview: record(row.result, MAX_PREVIEW_CHARS),
    })),
    hasMoreTimeline,
    nextTimelineCursor,
    activeGrant: activeAutonomyGrant(task, Date.now()),
    stuckWaiting,
  };
}

/** Load the same clipped Activity audit projection through a portable repository. */
export async function getTaskDetailWithRepository(
  repository: TaskActivityDetailRepository,
  agentId: string,
  taskId: string,
  options: { pageSize?: number; before?: Date; cursor?: string } = {},
): Promise<TaskDetail | null> {
  const pageSize = Math.max(
    1,
    Math.min(500, Math.floor(options.pageSize ?? TASK_TIMELINE_PAGE_SIZE)),
  );
  const detail = await repository.getDetail(agentId, taskId, {
    pageSize,
    ...(options.before ? { before: options.before } : {}),
    ...(options.cursor ? { cursor: decodeTaskTimelineCursor(options.cursor) } : {}),
  });
  if (!detail) return null;

  const { hasMoreTimeline, nextTimelineCursor, onPage } = timelinePage(
    detail.toolCalls,
    detail.modelCalls,
    detail.approvals,
    detail.messages,
    pageSize,
  );
  const { autonomyGrant, plan, state, ...task } = detail.task;
  const stateRecord = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const parsedChecklist = RequestChecklistSchema.safeParse(stateRecord.requestChecklist);
  const snapshot: TaskSnapshot = {
    ...task,
    plan: record(plan, MAX_RECORDED_CHARS),
    ...(parsedChecklist.success ? { checklist: { items: parsedChecklist.data.items } } : {}),
  };
  const decisionOf = (value: unknown) =>
    (value ?? {}) as { riskTier?: unknown; policyId?: unknown };

  return {
    timezone: detail.timezone,
    task: snapshot,
    toolCalls: detail.toolCalls
      .filter((row) => onPage('tool', row.id))
      .reverse()
      .map((row) => {
        const decision = decisionOf(row.decision);
        return {
          id: row.id,
          createdAt: row.createdAt,
          finishedAt: row.finishedAt,
          toolName: row.toolName,
          step: row.step,
          status: row.status,
          riskTier: typeof decision.riskTier === 'string' ? decision.riskTier : null,
          policyId: typeof decision.policyId === 'string' ? decision.policyId : null,
          args: record(row.args, MAX_RECORDED_CHARS),
          result: record(row.result, MAX_RECORDED_CHARS),
          error: record(row.error, MAX_RECORDED_CHARS),
        };
      }),
    modelCalls: detail.modelCalls.filter((row) => onPage('model', row.id)).reverse(),
    approvals: detail.approvals.filter((row) => onPage('approval', row.id)).reverse(),
    messages: detail.messages
      .filter((row) => onPage('message', row.id))
      .reverse()
      .map((row) => ({
        ...row,
        text:
          row.text.length > MAX_TIMELINE_MESSAGE_CHARS
            ? `${row.text.slice(0, MAX_TIMELINE_MESSAGE_CHARS)}…`
            : row.text,
      })),
    files: detail.files,
    actions: detail.actions.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      completed: completedSuccessfully(row.status, row.result),
      error: row.error,
      resultPreview: record(row.result, MAX_PREVIEW_CHARS),
    })),
    hasMoreTimeline,
    nextTimelineCursor,
    activeGrant: activeAutonomyGrant({ trust: task.trust, autonomyGrant }, Date.now()),
    stuckWaiting: task.status === 'waiting_approval' && !detail.hasPendingApproval,
  };
}

/** Whether an approval on this task is still waiting on the owner. */
async function hasPendingApproval(db: Db, taskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
    .limit(1);
  return Boolean(row);
}

function timelinePage(
  tools: Array<{ id: string; createdAt: Date; timelineAt?: string }>,
  models: Array<{ id: string; createdAt: Date; timelineAt?: string }>,
  approvals: Array<{ id: string; requestedAt: Date; timelineAt?: string }>,
  messages: Array<{ id: string; createdAt: Date; timelineAt?: string }>,
  pageSize: number,
) {
  const rows = [
    ...tools.map((r) => ({
      kind: 'tool' as const,
      id: r.id,
      at: r.timelineAt ?? timelineTime(r.createdAt),
    })),
    ...models.map((r) => ({
      kind: 'model' as const,
      id: r.id,
      at: r.timelineAt ?? timelineTime(r.createdAt),
    })),
    ...approvals.map((r) => ({
      kind: 'approval' as const,
      id: r.id,
      at: r.timelineAt ?? timelineTime(r.requestedAt),
    })),
    ...messages.map((r) => ({
      kind: 'message' as const,
      id: r.id,
      at: r.timelineAt ?? timelineTime(r.createdAt),
    })),
  ].sort(compareTimelineRows);
  const selected = rows.slice(0, pageSize);
  const ids = new Set(selected.map((r) => `${r.kind}:${r.id}`));
  const oldest = selected.at(-1);
  const hasMoreTimeline = rows.length > pageSize;
  return {
    hasMoreTimeline,
    nextTimelineCursor: hasMoreTimeline && oldest ? encodeTaskTimelineCursor(oldest) : null,
    onPage: (kind: TaskTimelineKind, id: string) => ids.has(`${kind}:${id}`),
  };
}
