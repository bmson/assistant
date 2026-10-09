import type { TaskLease } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { type PendingFinal, TaskStateSchema } from '../../events.js';
import { finalizePendingResponse } from './finalize.js';
import type { ExecutorDeps } from './types.js';

function fixture(type = 'email_triage') {
  const task = {
    id: 'final-delivery-task',
    agentId: 'owner',
    type,
    trust: 'owner',
    conversationId: 'conversation',
    trigger: { source: 'email', payload: {} },
    leaseToken: 'lease',
    lockedUntil: new Date(Date.now() + 60_000),
  } as unknown as TaskLease;
  const checkpoint = vi.fn(async (_task: unknown, state: unknown) => {
    savedStates.push(state as Record<string, unknown>);
    return true;
  });
  const savedStates: Record<string, unknown>[] = [];
  const complete = vi.fn(async () => true);
  const needsAttention = vi.fn(async () => true);
  const append = vi.fn(async () => undefined);
  const evidence = {
    finalMessageExists: async () => false,
    recordResponseCheck: async () => true,
  };
  const deps = {
    db: {},
    persistence: {
      tasks: {
        kind: 'task-lease-repository',
        renew: async () => true,
        checkpoint,
        completeTask: complete,
        markTaskNeedsAttention: needsAttention,
        markAttentionNotified: async () => true,
      },
      messages: { kind: 'message-repository', append },
      notifications: { kind: 'notifications-conversation-repository' },
      executionEvidence: evidence,
    },
    deliverFinal: vi.fn(),
  } as unknown as ExecutorDeps;
  const pending: PendingFinal = {
    text: 'The requested work is complete.',
    progress: 'Completed the request.',
    terminalStatus: 'done' as const,
    outcome: 'done' as const,
  };
  return {
    task,
    deps,
    pending,
    state: TaskStateSchema.parse({}),
    checkpoint,
    savedStates,
    complete,
    needsAttention,
    append,
  };
}

describe('final channel delivery receipts', () => {
  it('blocks completion when a required channel has no valid target', async () => {
    const f = fixture();
    f.deps.deliverFinal = vi.fn(async (_task, _text, attemptId) => ({
      channel: 'email',
      status: 'rejected' as const,
      attemptId,
      reason: 'missing-owner-target',
    }));

    const result = await finalizePendingResponse(f.deps, f.task, f.pending, f.state);

    expect(result.outcome).toBe('needs_attention');
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.needsAttention).toHaveBeenCalledOnce();
    expect(f.pending).toMatchObject({
      terminalStatus: 'needs_attention',
      finalDelivery: {
        legs: [{ channel: 'email', status: 'rejected', reason: 'missing-owner-target' }],
      },
    });
  });

  it('persists an ambiguous send and suppresses all automatic duplicate attempts', async () => {
    const f = fixture();
    f.deps.deliverFinal = vi.fn(async (_task, _text, attemptId) => {
      expect(f.savedStates.at(-1)?.pendingFinal).toMatchObject({
        finalDelivery: {
          legs: [{ channel: 'email', status: 'unknown', reason: 'provider-attempt-started' }],
        },
      });
      return {
        channel: 'email',
        status: 'unknown' as const,
        attemptId,
        reason: 'provider-outcome-unknown',
      };
    });

    await finalizePendingResponse(f.deps, f.task, f.pending, f.state);
    expect(f.deps.deliverFinal).toHaveBeenCalledOnce();
    expect(f.pending.finalDelivery).toMatchObject({
      legs: [{ status: 'unknown', attemptId: 'final-delivery-task:final:1' }],
    });
    expect(f.needsAttention).toHaveBeenCalledOnce();

    const retried = await finalizePendingResponse(f.deps, f.task, f.pending, f.state);
    expect(retried.outcome).toBe('needs_attention');
    expect(f.deps.deliverFinal).toHaveBeenCalledOnce();
  });

  it('allows dashboard-only finals with a not-applicable channel result', async () => {
    const f = fixture('chat_turn');
    f.deps.deliverFinal = vi.fn(async (_task, _text, attemptId) => ({
      channel: 'dashboard',
      status: 'not_applicable' as const,
      attemptId,
    }));

    const result = await finalizePendingResponse(f.deps, f.task, f.pending, f.state);

    expect(result.outcome).toBe('done');
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.needsAttention).not.toHaveBeenCalled();
  });
});
