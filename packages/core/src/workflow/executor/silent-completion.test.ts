import type { TaskRow } from '@assistant/db';
import type { TaskLease } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { TaskStateSchema } from '../../events.js';
import { finalizePendingResponse } from './finalize.js';
import { authorizesSilentCompletion, canCompleteSilently } from './silent-completion.js';
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
