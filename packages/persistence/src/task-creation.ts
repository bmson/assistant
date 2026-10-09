import { isDeepStrictEqual } from 'node:util';
import type { EmailObserverEffectFence } from './generated-cards.js';
import type { Records } from './records.js';
import { normalizeTaskBudget } from './task-budget.js';

type Task = Records['tasks'];
export interface EmailObserverTaskCreationFence extends EmailObserverEffectFence {
  /** Canonical `gmail:<provider message id>` that produced this task. */
  channelMessageId: string;
}
export type TaskCreateInput = Pick<Task, 'agentId' | 'type' | 'trust' | 'trigger'> &
  Partial<
    Pick<
      Task,
      | 'conversationId'
      | 'goalId'
      | 'title'
      | 'externalEventId'
      | 'parentTaskId'
      | 'runAfter'
      | 'deadline'
      | 'maxSteps'
      | 'budgetUsdLimit'
      | 'plan'
      | 'autonomyGrant'
      | 'nextAction'
      | 'reflectEvery'
    >
  > & {
    /** Optional source/claim fence for a task created by a durable email observer. */
    emailObserverTaskFence?: EmailObserverTaskCreationFence;
  };
export interface TaskCreateResult {
  task: Task;
  created: boolean;
}

export class TaskRateLimitError extends Error {
  constructor() {
    super('externally-triggered task rate limit exceeded');
    this.name = 'TaskRateLimitError';
  }
}

export function isExternalRoot(input: TaskCreateInput): boolean {
  return ['known', 'unknown'].includes(input.trust) && !input.parentTaskId;
}

/** Existing event IDs are installation-wide; never return another owner's task. */
export function existingTaskResult(task: Task, input: TaskCreateInput): TaskCreateResult {
  if (task.agentId !== input.agentId) throw new Error('Task event belongs to another agent');
  return { task, created: false };
}

/**
 * Event IDs are installation-wide. A fenced email replay may reuse an event
 * only when its complete task-creation projection is unchanged.
 */
export function existingFencedTaskResult(task: Task, input: TaskCreateInput): TaskCreateResult {
  const result = existingTaskResult(task, input);
  const expected = newTaskRecord(input, task.id, task.createdAt);
  const fields = [
    'type',
    'trust',
    'trigger',
    'title',
    'conversationId',
    'goalId',
    'parentTaskId',
    'externalEventId',
    'runAfter',
    'deadline',
    'maxSteps',
    'budgetUsdLimit',
    'plan',
    'autonomyGrant',
    'nextAction',
    'reflectEvery',
  ] as const;
  if (fields.some((field) => !isDeepStrictEqual(task[field], expected[field])))
    throw new Error('Task event does not match its fenced email source');
  return result;
}

/** Explicit defaults keep the Firestore record compatible with PostgreSQL/API rows. */
export function newTaskRecord(input: TaskCreateInput, id: string, now: Date): Task {
  const budgetUsdLimit = normalizeTaskBudget(input.budgetUsdLimit ?? '0.50');
  if (!input.agentId || !input.type || budgetUsdLimit === null)
    throw new Error('Invalid task creation input or task budget precision');
  const maxSteps = input.maxSteps ?? 12;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 2_147_483_647)
    throw new Error('Invalid task step limit');
  for (const date of [now, input.runAfter, input.deadline]) {
    if (date && !Number.isFinite(date.getTime())) throw new Error('Invalid task time');
  }
  if (
    !['owner', 'known', 'unknown', 'assistant'].includes(input.trust) ||
    ![
      'chat_turn',
      'sms_turn',
      'email_triage',
      'scheduled',
      'mission',
      'browser_job',
      'adhoc',
    ].includes(input.type)
  )
    throw new Error('Invalid task type or trust');
  return {
    id,
    agentId: input.agentId,
    type: input.type,
    trust: input.trust,
    trigger: input.trigger,
    title: input.title ?? null,
    status: input.runAfter ? 'sleeping' : 'pending',
    conversationId: input.conversationId ?? null,
    goalId: input.goalId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    externalEventId: input.externalEventId || null,
    runAfter: input.runAfter ?? null,
    deadline: input.deadline ?? null,
    maxSteps,
    budgetUsdLimit,
    spentUsd: '0.000000',
    plan: input.plan ?? null,
    autonomyGrant: input.autonomyGrant ?? null,
    state: {},
    progress: '',
    nextAction: input.nextAction ?? '',
    progressPercent: null,
    archivedAt: null,
    reflectEvery: input.reflectEvery ?? null,
    lastReflectedAt: null,
    lockedUntil: null,
    leaseToken: null,
    queueGeneration: 0,
    attempt: 0,
    reclaimCount: 0,
    attentionNotifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
