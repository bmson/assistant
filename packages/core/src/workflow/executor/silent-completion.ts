import type { Records } from '@assistant/persistence';

type TaskRow = Records['tasks'];

import type { TaskState } from '../../events.js';
import type { StepCallOutcome } from '../../model-router/router.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only a server-created arrival observation authorizes a successful silent final. */
export function authorizesSilentCompletion(task: TaskRow): boolean {
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
