import type { ApplicationChatPersistence } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { cancelChatTurn } from './chat.js';

const AGENT_ID = '00000000-0000-4000-8000-00000000000a';
const identity = {
  conversationId: '00000000-0000-4000-8000-00000000000c',
  clientOperationId: '00000000-0000-4000-8000-00000000000d',
};

describe('application chat cancellation', () => {
  it('resolves the configured owner and forwards only the stable request identity', async () => {
    const receipt = {
      kind: 'cancelled_before_admission' as const,
      task: { id: '00000000-0000-4000-8000-00000000000e' },
      status: 'cancelled' as const,
      transitioned: true,
      effectStatus: 'not_started' as const,
    };
    const cancel = vi.fn(async () => receipt);
    const persistence = {
      kind: 'application-chat-persistence' as const,
      resolveAgent: vi.fn(async () => ({ id: AGENT_ID })),
      cancelChatTurn: cancel,
    } as unknown as ApplicationChatPersistence;

    await expect(cancelChatTurn(persistence, identity)).resolves.toBe(receipt);
    expect(persistence.resolveAgent).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({ agentId: AGENT_ID, ...identity });
  });
});
