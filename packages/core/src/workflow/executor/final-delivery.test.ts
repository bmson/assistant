import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  type TaskLease,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { type PendingFinal, TaskStateSchema } from '../../events.js';
import { selectMemoryReadAnswer } from '../memory-read-answer.js';
import { buildReadToolInput, detectPersonalReadRequest } from '../read-intent.js';
import { type ActionEvidence, enforceResponseContract } from '../response-contract.js';
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
    savedStates.push(structuredClone(state) as Record<string, unknown>);
    return true;
  });
  const savedStates: Record<string, unknown>[] = [];
  const complete = vi.fn(async () => true);
  const needsAttention = vi.fn(async () => true);
  const append = vi.fn(async () => undefined);
  const renew = vi.fn(async () => true);
  const evidence = {
    finalMessageExists: async () => false,
    recordResponseCheck: async () => true,
  };
  const deps = {
    db: {},
    persistence: {
      tasks: {
        kind: 'task-lease-repository',
        renew,
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
    evidence,
    renew,
  };
}

describe('final channel delivery receipts', () => {
  it('delivers the exact incomplete-selection diagnostic produced by the private-read contract', async () => {
    const requestText = 'What did I tell you about open commitments for rainbow observation notes?';
    const readRequest = detectPersonalReadRequest([{ role: 'user', content: requestText }]);
    if (!readRequest) throw new Error('Expected an explicit private history request');
    expect(readRequest.kind).toBe('memory');
    const historyText = 'The owner observed coastal rainbows by the sea.';
    const evidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: buildReadToolInput(readRequest, 'conversations.search', []),
        result: {
          matches: [
            {
              messageId: 'rainbow-history',
              conversationId: 'historic-chat',
              text: historyText,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'rainbow-history',
                historyText,
                'user',
                'owner',
              ),
              sourceRevision: conversationMessageSourceRevision('rainbow-history', historyText),
              createdAt: '2026-10-10T12:00:00.000Z',
            },
          ],
        },
      },
    ];
    const selection = await selectMemoryReadAnswer({
      router: {
        object: async () => ({ ok: true, object: { selections: [] } }),
      } as never,
      taskId: 'incomplete-private-read',
      request: requestText,
      evidence,
    });
    expect(selection).toMatchObject({
      status: 'unavailable',
      failureReason: 'incomplete_selection',
      selections: [],
    });
    const checked = enforceResponseContract('', evidence, {
      readRequest,
      requestText,
      memoryReadSelection: selection,
    });
    const diagnostic =
      'I found candidate owner-authored records, but could not reliably select a directly relevant passage.';
    expect(checked.text).toContain(diagnostic);

    const f = fixture('chat_turn');
    f.pending.text = checked.text;
    f.pending.progress = checked.text.slice(0, 200);
    f.pending.terminalStatus = 'needs_attention';
    f.pending.outcome = 'needs_attention';
    f.pending.contractBlocked = checked.blocked;
    f.deps.deliverFinal = vi.fn(async (_task, text, attemptId) => {
      expect(text).toBe(checked.text);
      return { channel: 'dashboard', status: 'not_applicable' as const, attemptId };
    });

    const result = await finalizePendingResponse(f.deps, f.task, f.pending, f.state);

    expect(result.outcome).toBe('needs_attention');
    expect(f.deps.deliverFinal).toHaveBeenCalledOnce();
    expect(f.deps.deliverFinal).toHaveBeenCalledWith(
      f.task,
      expect.stringContaining(diagnostic),
      expect.any(String),
      undefined,
    );
  });

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

  it.each([
    ['done', 'done', 'Completed the request.'],
    ['needs_attention', 'needs_attention', 'Waiting for owner decision.'],
    ['done', 'clarify', 'Asked for clarification.'],
    ['failed', 'failed', 'The requested operation failed.'],
  ] as const)(
    'restores the original %s/%s completion contract after rejected delivery recovery',
    async (terminalStatus, outcome, progress) => {
      const f = fixture();
      Object.assign(f.pending, { terminalStatus, outcome, progress });
      f.deps.deliverFinal = vi
        .fn<NonNullable<ExecutorDeps['deliverFinal']>>()
        .mockImplementationOnce(async (_task, _text, attemptId) => ({
          channel: 'email',
          status: 'rejected',
          attemptId,
        }))
        .mockImplementationOnce(async (_task, _text, attemptId) => ({
          channel: 'email',
          status: 'accepted',
          attemptId,
        }));
      await finalizePendingResponse(f.deps, f.task, f.pending, f.state);
      const restored = TaskStateSchema.parse(f.savedStates.at(-1));
      const pending = restored.pendingFinal;
      if (!pending) throw new Error('Missing durable delivery checkpoint');
      expect(pending.progress).toContain('delivery was rejected');
      const result = await finalizePendingResponse(f.deps, f.task, pending, restored);
      expect(result).toMatchObject({ outcome, detail: progress });
      expect(pending).toMatchObject({
        terminalStatus,
        outcome,
        progress,
        deliveryNeedsAttention: false,
        preDeliveryCompletion: { terminalStatus, outcome, progress },
      });
      expect(f.deps.deliverFinal).toHaveBeenCalledTimes(2);
      expect(f.complete).toHaveBeenCalledTimes(terminalStatus === 'needs_attention' ? 0 : 1);
      expect(f.needsAttention).toHaveBeenCalledTimes(terminalStatus === 'needs_attention' ? 2 : 1);
    },
  );

  it('keeps an accepted legacy retry open when its original completion contract was not recorded', async () => {
    const f = fixture();
    Object.assign(f.pending, {
      text: 'Everything is complete.',
      terminalStatus: 'needs_attention',
      outcome: 'needs_attention',
      progress: 'Final email delivery was rejected.',
      deliveryNeedsAttention: true,
      deliveryAttempted: true,
      finalDelivery: { legs: [{ channel: 'email', status: 'rejected', attemptId: 'legacy:1' }] },
    });
    f.deps.deliverFinal = vi.fn<NonNullable<ExecutorDeps['deliverFinal']>>(
      async (_task, _text, attemptId) => ({
        channel: 'email',
        status: 'accepted',
        attemptId,
      }),
    );
    const result = await finalizePendingResponse(f.deps, f.task, f.pending, f.state);
    expect(result.outcome).toBe('needs_attention');
    expect(f.pending.progress).toContain('original completion outcome was not recorded');
    expect(f.pending.progress).not.toContain('rejected');
    expect(f.pending.deliveryNeedsAttention).toBe(false);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.needsAttention).toHaveBeenCalledOnce();
  });

  it('does not start a dashboard append when Stop commits during the existence lookup', async () => {
    const f = fixture();
    let releaseLookup: (exists: boolean) => void = () => undefined;
    let lookupStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const lookup = new Promise<boolean>((resolve) => {
      releaseLookup = resolve;
    });
    f.evidence.finalMessageExists = async () => {
      lookupStarted();
      return lookup;
    };
    const finalizing = finalizePendingResponse(f.deps, f.task, f.pending, f.state);
    await started;
    f.renew.mockResolvedValue(false);
    releaseLookup(false);
    expect((await finalizing).outcome).toBe('not_claimable');
    expect(f.append).not.toHaveBeenCalled();
    expect(f.deps.deliverFinal).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('retains an already-started dashboard append while blocking later channel dispatch', async () => {
    const f = fixture();
    f.append.mockImplementation(async () => {
      // This write has already started when Stop revokes later lease checks.
      f.renew.mockResolvedValue(false);
      f.checkpoint.mockResolvedValue(false);
    });
    expect((await finalizePendingResponse(f.deps, f.task, f.pending, f.state)).outcome).toBe(
      'not_claimable',
    );
    expect(f.append).toHaveBeenCalledOnce();
    expect(f.deps.deliverFinal).not.toHaveBeenCalled();
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
