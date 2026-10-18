import type { TaskRow } from '@assistant/db';
import type { TaskLease } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { TaskStateSchema } from '../../events.js';
import { finalizePendingResponse } from './finalize.js';
import {
  authorizesSilentCompletion,
  canCompleteSilently,
  hasQuietGoalEvidence,
} from './silent-completion.js';
import type { ExecutorDeps } from './types.js';

const task = {
  agentId: 'owner',
  id: 'arrival-task',
  trust: 'assistant',
  type: 'adhoc',
  conversationId: null,
  parentTaskId: null,
  trigger: {
    source: 'internal',
    externalEventId: 'arrival:owner:2026-10-07:grid',
    payload: { completionPolicy: { version: 1, kind: 'successful_silent' } },
  },
} as unknown as TaskLease;
const state = TaskStateSchema.parse({});
const result = {
  ok: true as const,
  modelId: 'fake',
  degraded: false,
  text: '',
  toolCalls: [],
  finishReason: 'stop',
};
describe('authorized successful silence', () => {
  it('limits quiet goal checks to recurring occurrences with fresh verified progress', () => {
    const goal = {
      ...task,
      type: 'scheduled',
      goalId: 'goal',
      conversationId: 'work',
      trigger: {
        source: 'schedule',
        externalEventId: 'schedule:runner:occurrence',
        payload: {
          schedule: 'goal:goal',
          goalId: 'goal',
          scheduleId: 'runner',
          occurrenceId: 'schedule:runner:occurrence',
        },
      },
    } as TaskLease;
    expect(canCompleteSilently(goal, state, result)).toBe(true);
    for (const patch of [
      { trust: 'owner' },
      { type: 'chat_turn' },
      { goalId: 'other' },
      { conversationId: null },
      { trigger: { source: 'schedule', payload: { instruction: 'stay quiet' } } },
    ])
      expect(authorizesSilentCompletion({ ...goal, ...patch } as TaskRow)).toBe(false);
    const work = { toolName: 'web.fetch', status: 'succeeded', result: { status: 200 }, step: 1 };
    const checkpoint = {
      toolName: 'goals.update_progress',
      status: 'succeeded',
      result: { updated: 'goal' },
      step: 2,
    };
    expect(hasQuietGoalEvidence([work, checkpoint])).toBe(true);
    for (const rows of [
      [],
      [checkpoint],
      [work],
      [checkpoint, { ...work, step: 3 }],
      [work, { ...checkpoint, step: 1 }],
      [work, checkpoint, { ...work, status: 'failed' }],
      [{ ...work, result: { ok: false } }, checkpoint],
      [work, checkpoint, { ...work, result: { deliveryStatus: 'unknown' } }],
    ])
      expect(hasQuietGoalEvidence(rows)).toBe(false);
  });

  it('revalidates goal evidence on recovery before silently completing', async () => {
    const goal = {
      ...task,
      type: 'scheduled',
      goalId: 'goal',
      conversationId: 'work',
      trigger: {
        source: 'schedule',
        externalEventId: 'schedule:runner:occurrence',
        payload: {
          goalId: 'goal',
          schedule: 'goal:goal',
          scheduleId: 'runner',
          occurrenceId: 'schedule:runner:occurrence',
        },
      },
    } as TaskLease;
    const complete = vi.fn();
    const deps = {
      db: {},
      persistence: {
        tasks: { kind: 'task-lease-repository', renew: async () => true, completeTask: complete },
        executionEvidence: { taskEvidence: async () => [] },
      },
    } as unknown as ExecutorDeps;
    await expect(
      finalizePendingResponse(
        deps,
        goal,
        {
          completionKind: 'successful_silent',
          text: '',
          progress: 'checked',
          terminalStatus: 'done',
          outcome: 'done',
        },
        state,
      ),
    ).rejects.toThrow('requires verified, checkpointed work');
    expect(complete).not.toHaveBeenCalled();
  });
  it('accepts an explicit successful stop only for server-created arrival jobs', () => {
    expect(canCompleteSilently(task, state, result)).toBe(true);
    for (const patch of [
      { trust: 'owner' },
      { type: 'chat_turn' },
      { conversationId: 'chat' },
      { parentTaskId: 'mission' },
      { trigger: { source: 'internal', payload: { instruction: 'Send nothing' } } },
      { trigger: { ...(task.trigger as object), externalEventId: 'arrival:foreign:grid' } },
    ]) {
      expect(authorizesSilentCompletion({ ...task, ...patch } as TaskRow)).toBe(false);
    }
    for (const finishReason of ['length', 'error', undefined])
      expect(canCompleteSilently(task, state, { ...result, finishReason })).toBe(false);
    expect(canCompleteSilently(task, state, { ...result, qualityFailure: true })).toBe(false);
  });
  it('completes without writing a message or calling external delivery, including persisted retry', async () => {
    const complete = vi.fn(async () => true);
    const delivered = vi.fn();
    const messages = vi.fn();
    const deps = {
      db: {},
      persistence: {
        tasks: { kind: 'task-lease-repository', renew: async () => true, completeTask: complete },
        executionEvidence: { recordResponseCheck: async () => true },
        messages: { persist: messages },
      },
      deliverFinal: delivered,
    } as unknown as ExecutorDeps;
    const pending = {
      completionKind: 'successful_silent' as const,
      text: '',
      progress: 'No useful arrival note.',
      terminalStatus: 'done' as const,
      outcome: 'done' as const,
    };
    expect(await finalizePendingResponse(deps, task, pending, state)).toMatchObject({
      outcome: 'done',
    });
    expect(complete).toHaveBeenCalledWith(task, { status: 'done', progress: pending.progress });
    expect(messages).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    await expect(
      finalizePendingResponse(deps, { ...task, trust: 'owner' }, pending, state),
    ).rejects.toThrow('not authorized');
  });
});
