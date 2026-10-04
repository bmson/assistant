import type { ApnsClient } from '@assistant/tools/modules/push';
import { describe, expect, it, vi } from 'vitest';
import { notifyApprovalsByPush, notifyOwnerByPush } from './channel.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';

function channel() {
  const send = vi.fn(async () => ({ ok: true }));
  return {
    send,
    deps: {
      apns: { configured: () => true, send } as unknown as ApnsClient,
      devices: {
        listActive: async () => [{ token: 'synthetic', environment: 'sandbox' as const }],
        invalidate: async () => {},
      },
      owner: async () => ({ id: 'owner', name: 'Ada' }),
    },
  };
}

describe('push navigation identity', () => {
  it('retains the owner and actual conversation without changing the notification category', async () => {
    const { deps, send } = channel();
    await notifyOwnerByPush(deps, { text: 'Your flight changed.', conversationId, taskId });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ASSISTANT_UPDATE',
        data: { route: 'chat', agentId: 'owner', conversationId, taskId },
      }),
    );
  });

  it('drops paths, URLs and malformed destinations while keeping the legacy main-chat route', async () => {
    for (const invalid of ['../other-owner', 'https://other.example', 'not-an-id', null]) {
      const { deps, send } = channel();
      await notifyOwnerByPush(deps, {
        text: 'Update',
        conversationId: invalid,
        taskId: invalid ?? undefined,
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { route: 'chat', agentId: 'owner' },
        }),
      );
    }
  });

  it('scopes approval navigation to the owner without inventing an actionable approval ID', async () => {
    const { deps, send } = channel();
    await notifyApprovalsByPush(deps, [{ taskId, shortCode: 'A7', summary: 'Send the RSVP' }]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ASSISTANT_ATTENTION',
        data: { route: 'approvals', agentId: 'owner' },
      }),
    );
  });
});
