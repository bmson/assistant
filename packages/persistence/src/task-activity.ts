import type { Records } from './records.js';
import type { TaskTimelineCursor } from './task-timeline.js';

/** The actionable task rows in the owner-facing Needs You filter. */
export const needsYouTaskStatuses = [
  'waiting_approval',
  'waiting_budget',
  'waiting_estimated_cost',
  'needs_attention',
] as const;

export function canArchiveActivityStatus(status: string): boolean {
  return ['done', 'failed', 'cancelled', 'needs_attention'].includes(status);
}

export function isActivityCanary(trigger: unknown): boolean {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const payload = (trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = (payload as { canary?: unknown }).canary;
  return value === true || value === 'true';
}

export interface TaskActivityDiagnostic {
  id: string;
  text: string;
}

const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_TEXT = 3_000;

export function taskActivityDiagnostics(state: unknown): TaskActivityDiagnostic[] {
  const records = (state as { activityDiagnostics?: unknown } | null)?.activityDiagnostics;
  if (!Array.isArray(records)) return [];
  return records.slice(-MAX_DIAGNOSTICS).flatMap((record) => {
    if (!record || typeof record.id !== 'string' || typeof record.text !== 'string') return [];
    return [{ id: record.id, text: record.text.slice(0, MAX_DIAGNOSTIC_TEXT) }];
  });
}

export function recordTaskActivityDiagnostic(
  state: unknown,
  diagnostic: TaskActivityDiagnostic,
): Record<string, unknown> | null {
  const records = taskActivityDiagnostics(state);
  if (records.some(({ id }) => id === diagnostic.id)) return null;
  return {
    ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
    activityDiagnostics: [
      ...records.slice(1 - MAX_DIAGNOSTICS),
      { id: diagnostic.id, text: diagnostic.text.slice(0, MAX_DIAGNOSTIC_TEXT) },
    ],
  };
}

export function isActivityDiagnosticJob(
  task: Pick<Records['tasks'], 'trigger' | 'trust' | 'conversationId'>,
): boolean {
  if (task.trust !== 'assistant' || task.conversationId) return false;
  const trigger = task.trigger as { source?: unknown; payload?: { job?: unknown } } | null;
  if (trigger?.source !== 'schedule') return false;
  const job = trigger.payload?.job;
  return job === 'self.repair' || job === 'health.monitor' || job === 'dream.run';
}

export function activityRetriesExhaustedDiagnostic(
  queueGeneration: number,
): TaskActivityDiagnostic {
  return {
    id: `retries-exhausted:${queueGeneration}`,
    text: 'This scheduled run exhausted its retries. You can retry it from Activity.',
  };
}

export function activityDiagnosticDeduplicationKey(agentId: string, id: string): string | null {
  return id.startsWith('self-repair:') ? `activity-diagnostic:${agentId}:${id}` : null;
}

export type ActivityTaskRecord = Pick<
  Records['tasks'],
  | 'id'
  | 'agentId'
  | 'conversationId'
  | 'externalEventId'
  | 'type'
  | 'status'
  | 'title'
  | 'progress'
  | 'trust'
  | 'spentUsd'
  | 'budgetUsdLimit'
  | 'updatedAt'
  | 'archivedAt'
  | 'autonomyGrant'
  | 'trigger'
> & { state?: unknown };

export interface TaskActivityRepository {
  readonly kind: 'task-activity-repository';
  list(
    agentId: string,
    input: { archived: boolean; statuses?: string[]; limit: number },
  ): Promise<{
    tasks: ActivityTaskRecord[];
    archivedCount: number;
    pendingApprovalTaskIds: string[];
  }>;
  getStatus(
    agentId: string,
    taskId: string,
  ): Promise<{ task: ActivityTaskRecord; hasPendingApproval: boolean } | null>;
}

type Timed<T> = T & { timelineAt?: string };

export interface TaskActivityDetail {
  timezone: string;
  task: Pick<
    Records['tasks'],
    | 'id'
    | 'type'
    | 'status'
    | 'title'
    | 'trust'
    | 'spentUsd'
    | 'budgetUsdLimit'
    | 'updatedAt'
    | 'deadline'
    | 'nextAction'
    | 'progress'
    | 'progressPercent'
    | 'plan'
    | 'state'
    | 'archivedAt'
    | 'autonomyGrant'
  >;
  toolCalls: Array<
    Timed<
      Pick<
        Records['toolCalls'],
        | 'id'
        | 'createdAt'
        | 'finishedAt'
        | 'toolName'
        | 'step'
        | 'status'
        | 'decision'
        | 'args'
        | 'result'
        | 'error'
      >
    >
  >;
  modelCalls: Array<
    Timed<
      Pick<Records['modelCalls'], 'id' | 'createdAt' | 'role' | 'model' | 'costUsd' | 'latencyMs'>
    >
  >;
  approvals: Array<
    Timed<
      Pick<
        Records['approvals'],
        'id' | 'requestedAt' | 'status' | 'summary' | 'shortCode' | 'resolvedVia' | 'resolvedAt'
      >
    >
  >;
  messages: Array<Timed<Pick<Records['messages'], 'id' | 'createdAt' | 'role' | 'text'>>>;
  files: Array<Pick<Records['files'], 'id' | 'workspacePath' | 'bytes'>>;
  actions: Array<
    Pick<
      Records['toolCalls'],
      'id' | 'createdAt' | 'finishedAt' | 'toolName' | 'status' | 'result' | 'error'
    >
  >;
  hasPendingApproval: boolean;
}

/** Owner-scoped bounded task detail read, including only fields rendered by Activity. */
export interface TaskActivityDetailRepository {
  getDetail(
    agentId: string,
    taskId: string,
    input: { pageSize: number; before?: Date; cursor?: TaskTimelineCursor },
  ): Promise<TaskActivityDetail | null>;
}
