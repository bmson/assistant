import type { Records } from '@assistant/persistence';

type TaskRow = Records['tasks'];

import type { TaskState } from '../../events.js';
import type { StepCallOutcome } from '../../model-router/router.js';
import {
  type GoalToolEvidence,
  isGoalWorkEvidence,
  needsGoalProgressUpdate,
} from '../goal-evidence.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Bind quiet goal completion to an actual recurring goal occurrence, never an owner turn. */
export function isScheduledGoalCheck(task: TaskRow): boolean {
  const trigger = object(task.trigger);
  const payload = object(trigger.payload);
  return (
    task.trust === 'assistant' &&
    task.type === 'scheduled' &&
    Boolean(task.goalId) &&
    Boolean(task.conversationId) &&
    !task.parentTaskId &&
    trigger.source === 'schedule' &&
    payload.goalId === task.goalId &&
    payload.schedule === `goal:${task.goalId}` &&
    typeof payload.scheduleId === 'string' &&
    typeof trigger.externalEventId === 'string' &&
    trigger.externalEventId.startsWith(`schedule:${payload.scheduleId}:`) &&
    payload.occurrenceId === trigger.externalEventId
  );
}

/** A quiet goal check still needs verified work and its durable progress checkpoint. */
export function hasQuietGoalEvidence(evidence: GoalToolEvidence[]): boolean {
  return (
    evidence.some(isGoalWorkEvidence) &&
    !needsGoalProgressUpdate(evidence) &&
    evidence.every((row) => row.status === 'succeeded' || row.status === 'cached') &&
    evidence.every((row) => {
      const result = object(row.result);
      return (
        result.ok !== false &&
        !(typeof result.status === 'number' && result.status >= 400) &&
        result.deliveryStatus !== 'unknown'
      );
    })
  );
}

/** Server-created arrival observations and recurring goal checks may finish quietly. */
export function authorizesSilentCompletion(task: TaskRow): boolean {
  if (isScheduledGoalCheck(task)) return true;
  const trigger = object(task.trigger);
  const payload = object(trigger.payload);
  const policy = object(payload.completionPolicy);
  return (
    task.trust === 'assistant' &&
    task.type === 'adhoc' &&
    !task.conversationId &&
    !task.parentTaskId &&
    trigger.source === 'internal' &&
    typeof trigger.externalEventId === 'string' &&
    trigger.externalEventId.startsWith(`arrival:${task.agentId}:`) &&
    policy.version === 1 &&
    policy.kind === 'successful_silent'
  );
}

export function canCompleteSilently(
  task: TaskRow,
  state: TaskState,
  result: StepCallOutcome,
): boolean {
  return (
    authorizesSilentCompletion(task) &&
    result.ok &&
    result.finishReason === 'stop' &&
    !result.qualityFailure &&
    !result.text.trim() &&
    result.toolCalls.length === 0 &&
    !state.pendingJob &&
    !state.pendingToolBatch?.calls.some((call) => call.status !== 'settled') &&
    !state.pendingApprovals?.length &&
    !state.requestChecklist?.items.some((item) => item.status !== 'completed')
  );
}
