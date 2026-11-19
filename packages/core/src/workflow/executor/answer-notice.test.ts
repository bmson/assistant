import type { TaskRow } from '@assistant/db';
import { describe, expect, it, vi } from 'vitest';
import { notifyOwnerOfDeliveredAnswer } from './notices.js';
import type { ExecutorDeps } from './types.js';

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    conversationId: 'conversation-1',
    trust: 'owner',
    type: 'chat_turn',
    ...over,
  } as TaskRow;
}

function deps(notifyOwner?: ExecutorDeps['notifyOwner']): ExecutorDeps {
  return { notifyOwner } as unknown as ExecutorDeps;
}

describe('telling the owner their answer landed', () => {
  it('sends only a generic ambient notice with the source thread', async () => {
    const notifyOwner = vi.fn(async () => ({
      legs: [{ channel: 'push', status: 'delivered' as const }],
    }));

    await expect(
      notifyOwnerOfDeliveredAnswer(deps(notifyOwner), task(), '  Booked for Friday at noon.  '),
    ).resolves.toBe(true);

    expect(notifyOwner).toHaveBeenCalledWith({
      deliveryKey: 'task-answer:e056239c1a5e1cf6ffda57b9cc656cef068f5a8ca52241488d0723249fc80719',
      taskId: 'task-1',
      conversationId: 'conversation-1',
      purpose: 'answer-ready',
      text: 'Your reply is ready.',
      urgency: 'ambient',
    });
  });

  it('stays silent when there is no notifier installed', async () => {
    // A self-hosted install without the push module: no APNs, nothing to do.
    await expect(notifyOwnerOfDeliveredAnswer(deps(undefined), task(), 'done')).resolves.toBe(
      false,
    );
  });

  it('stays silent rather than pushing an empty notification', async () => {
    const notifyOwner = vi.fn(async () => {});

    await expect(notifyOwnerOfDeliveredAnswer(deps(notifyOwner), task(), '   \n  ')).resolves.toBe(
      false,
    );
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('never fails a task that already succeeded', async () => {
    // The answer is durably in the thread by this point. A push outage is not
    // a reason to fail, retry, or re-run the model.
    const notifyOwner = vi.fn(async () => {
      throw new Error('APNs unreachable');
    });

    await expect(notifyOwnerOfDeliveredAnswer(deps(notifyOwner), task(), 'done')).resolves.toBe(
      false,
    );
  });
});
