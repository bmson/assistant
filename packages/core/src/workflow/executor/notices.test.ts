import type { TaskRow } from '@assistant/db';
import type { NotificationDeliveryResult } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  isBackgroundTask,
  noticeParts,
  notifyOwnerAndConversation,
  taskBudgetPermissionRequest,
} from './notices.js';
import type { ExecutorDeps } from './types.js';

describe('taskBudgetPermissionRequest', () => {
  it('proposes a bounded, runtime-calculated task cap and asks permission', () => {
    const task = {
      id: '090db434-02f8-4d4e-8849-2b9cc3df1285',
      budgetUsdLimit: '0.2500',
      spentUsd: '0.106100',
    } as TaskRow;

    const request = taskBudgetPermissionRequest(
      task,
      'task budget cannot cover this (spent $0.1061 + held $0.0000 + est $0.1898 > cap $0.2750 including owner-reply carve-out)',
    );

    expect(request.part).toMatchObject({
      type: 'budget-request',
      taskId: task.id,
      currentBudgetUsd: 0.25,
      proposedBudgetUsd: 0.5,
      spentUsd: 0.1061,
    });
    expect(request.text).toContain('permission');
    expect(request.text).toContain("won't increase the budget without your approval");
  });
});

describe('noticeParts', () => {
  it('marks plain prose so the chat renders it as a card, not a reply', () => {
    expect(noticeParts('parked')).toEqual([{ type: 'notice', notice: 'parked' }]);
    expect(noticeParts('needs-attention', [{ type: 'recall', sources: [] }])).toEqual([
      { type: 'recall', sources: [] },
      { type: 'notice', notice: 'needs-attention' },
    ]);
  });

  it('leaves a message that already speaks for itself alone', () => {
    // A budget request already renders as its own card; marking it too would
    // leave the interface choosing which of the two to show.
    const budget = [{ type: 'budget-request', taskId: 'x', proposedBudgetUsd: 1 }];
    expect(noticeParts('needs-attention', budget)).toBe(budget);
    const approval = [{ type: 'approval', approvalId: 'x' }];
    expect(noticeParts('needs-attention', approval)).toBe(approval);
    const already = [{ type: 'notice', notice: 'response-contract' }];
    expect(noticeParts('parked', already)).toBe(already);
  });
});

describe("background work stays out of the owner's chat and phone", () => {
  const background = {
    id: 'bg-task',
    agentId: 'agent-1',
    conversationId: null,
    trust: 'assistant',
  } as TaskRow;
  const asked = {
    ...background,
    id: 'chat-task',
    conversationId: 'chat-1',
    trust: 'owner',
  } as TaskRow;

  function deps(
    ownerResult: NotificationDeliveryResult = {
      legs: [{ channel: 'push', status: 'delivered' }],
    },
  ) {
    const append = vi.fn(async (input: unknown) => ({ id: 'm1', ...(input as object) }));
    const notifyOwner = vi.fn(async () => ownerResult);
    const getOrCreate = vi.fn(async () => 'notifications-1');
    return {
      append,
      notifyOwner,
      getOrCreate,
      deps: {
        notifyOwner,
        persistence: {
          messages: { kind: 'message-repository', append },
          notifications: { getOrCreate },
        },
      } as unknown as ExecutorDeps,
    };
  }

  it('tells scheduled work from work the owner asked for', () => {
    expect(isBackgroundTask(background)).toBe(true);
    expect(isBackgroundTask(asked)).toBe(false);
    expect(isBackgroundTask({ ...background, trust: 'owner' })).toBe(false);
  });

  it('logs a stalled scheduled job in Notifications and does not mirror or ping', async () => {
    const { deps: d, append, notifyOwner, getOrCreate } = deps();
    const result = await notifyOwnerAndConversation(d, background, 'It did not finish.');
    expect(result).toEqual({
      conversationNotified: true,
      ownerNotified: false,
      legs: [{ channel: 'notifications-conversation', status: 'delivered' }],
    });
    expect(getOrCreate).toHaveBeenCalledWith('agent-1');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'notifications-1', taskId: 'bg-task' }),
    );
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('still tells the owner about work they asked for, in their own conversation', async () => {
    const { deps: d, append, notifyOwner } = deps();
    const result = await notifyOwnerAndConversation(d, asked, "I couldn't finish that.");
    expect(result).toEqual({
      conversationNotified: true,
      ownerNotified: true,
      legs: [
        { channel: 'task-conversation', status: 'delivered' },
        { channel: 'push', status: 'delivered' },
      ],
    });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'chat-1' }));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('marks a provider outage so it renders as an interrupted response, not a question', async () => {
    const { deps: d, append } = deps();
    await notifyOwnerAndConversation(d, asked, "I couldn't finish that.", [], 'provider-failed');
    const [call] = append.mock.calls;
    const parts = JSON.stringify((call?.[0] as { parts?: unknown } | undefined)?.parts);
    expect(parts).toContain('"notice":"provider-failed"');
    expect(parts).not.toContain('"notice":"needs-attention"');
  });

  it('reports total delivery failure without claiming an owner-visible notice', async () => {
    const {
      deps: d,
      append,
      notifyOwner,
    } = deps({
      legs: [
        { channel: 'sms', status: 'failed' },
        { channel: 'push', status: 'skipped' },
      ],
    });
    append.mockRejectedValue(new Error('conversation store unavailable'));
    const result = await notifyOwnerAndConversation(d, asked, "I couldn't finish that.");
    expect(result.conversationNotified).toBe(false);
    expect(result.ownerNotified).toBe(false);
    expect(result.legs.map(({ channel, status }) => [channel, status])).toEqual([
      ['task-conversation', 'failed'],
      ['sms', 'failed'],
      ['push', 'skipped'],
    ]);
    expect(notifyOwner).toHaveBeenCalledOnce();
  });
});
