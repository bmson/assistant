import { describe, expect, it, vi } from 'vitest';
import {
  type ChatOperationTurnFence,
  isCancelledBeforeAdmissionSend,
  isCurrentChatOperation,
  requestChatOperationCancellation,
} from './chat-operation-cancellation-client';

const identity = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  clientOperationId: '22222222-2222-4222-8222-222222222222',
};
const fence: ChatOperationTurnFence = { ...identity, turnToken: 1, scopeGeneration: 3 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('web ordinary chat operation cancellation client', () => {
  it('retries the same identity after an unconfirmed response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            outcome: 'unknown',
            code: 'cancellation_unconfirmed',
            ...identity,
            taskId: null,
            effectStatus: 'unknown',
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          outcome: 'cancelled_before_admission',
          ...identity,
          taskId: null,
          transitioned: true,
          effectStatus: 'not_started',
        }),
      );

    expect(await requestChatOperationCancellation(fence, fetcher)).toEqual({ kind: 'unknown' });
    expect(await requestChatOperationCancellation(fence, fetcher)).toEqual({
      kind: 'confirmed',
      outcome: 'cancelled_before_admission',
      taskId: null,
      taskStatus: null,
      transitioned: true,
      effectStatus: 'not_started',
    });
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe('/api/chat/cancel');
      expect(call[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
      expect(JSON.parse(String(call[1]?.body))).toEqual(identity);
      expect(Object.keys(JSON.parse(String(call[1]?.body))).sort()).toEqual([
        'clientOperationId',
        'conversationId',
      ]);
    }
  });

  it('does not turn a conflict or wrong-identity response into a cancellation receipt', async () => {
    const conflict = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            outcome: 'operation_conflict',
            code: 'operation_conflict',
            ...identity,
            taskId: null,
          },
          409,
        ),
      ),
    );
    expect(conflict).toEqual({ kind: 'unknown' });

    const wrongOwner = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          outcome: 'cancelled_before_admission',
          ...identity,
          conversationId: '33333333-3333-4333-8333-333333333333',
          taskId: null,
          effectStatus: 'not_started',
        }),
      ),
    );
    expect(wrongOwner).toEqual({ kind: 'unknown' });
  });

  it('recognizes only the exact send-side cancellation-first 409', () => {
    const receipt = {
      ok: false,
      outcome: 'cancelled_before_admission',
      reason: 'cancelled_before_admission',
      code: 'chat_turn_cancelled_before_admission',
      effectStatus: 'not_started',
      conversationId: identity.conversationId,
      clientOperationId: identity.clientOperationId,
      taskId: null,
    };
    expect(isCancelledBeforeAdmissionSend(receipt, identity)).toBe(true);
    expect(
      isCancelledBeforeAdmissionSend(
        { ...receipt, taskId: '44444444-4444-4444-8444-444444444444' },
        identity,
      ),
    ).toBe(false);
    expect(
      isCancelledBeforeAdmissionSend(
        { ...receipt, clientOperationId: '33333333-3333-4333-8333-333333333333' },
        identity,
      ),
    ).toBe(false);
    expect(
      isCancelledBeforeAdmissionSend({ ...receipt, code: 'operation_conflict' }, identity),
    ).toBe(false);
  });

  it('requires transition receipts to be internally consistent', async () => {
    const wrongTransition = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          outcome: 'already_cancelled',
          ...identity,
          taskId: '44444444-4444-4444-8444-444444444444',
          taskStatus: 'cancelled',
          transitioned: true,
          effectStatus: 'unknown',
        }),
      ),
    );
    expect(wrongTransition).toEqual({ kind: 'unknown' });

    const missingTransition = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          outcome: 'cancelled_before_admission',
          ...identity,
          taskId: null,
          effectStatus: 'not_started',
        }),
      ),
    );
    expect(missingTransition).toEqual({ kind: 'unknown' });
  });

  it('keeps dispatched effect status unknown for task cancellation receipts', async () => {
    const taskId = '44444444-4444-4444-8444-444444444444';
    const cancelled = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          outcome: 'cancelled',
          ...identity,
          taskId,
          taskStatus: 'cancelled',
          transitioned: true,
          effectStatus: 'unknown',
        }),
      ),
    );
    expect(cancelled).toEqual({
      kind: 'confirmed',
      outcome: 'cancelled',
      taskId,
      taskStatus: 'cancelled',
      transitioned: true,
      effectStatus: 'unknown',
    });

    const terminal = await requestChatOperationCancellation(
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          outcome: 'already_terminal',
          ...identity,
          taskId,
          taskStatus: 'done',
          transitioned: false,
          effectStatus: 'unknown',
        }),
      ),
    );
    expect(terminal).toEqual({
      kind: 'confirmed',
      outcome: 'already_terminal',
      taskId,
      taskStatus: 'done',
      transitioned: false,
      effectStatus: 'unknown',
    });
  });

  it('fences late cancellation results after a new turn or scope replaces the captured one', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = requestChatOperationCancellation(identity, fetcher);
    const nextSameConversation: ChatOperationTurnFence = {
      ...identity,
      clientOperationId: '33333333-3333-4333-8333-333333333333',
      turnToken: 2,
      scopeGeneration: 3,
    };
    expect(isCurrentChatOperation(nextSameConversation, fence)).toBe(false);
    expect(isCurrentChatOperation({ ...fence, scopeGeneration: 4 }, fence)).toBe(false);
    release(
      jsonResponse({
        ok: true,
        outcome: 'cancelled_before_admission',
        ...identity,
        taskId: null,
        transitioned: true,
        effectStatus: 'not_started',
      }),
    );
    expect((await pending).kind).toBe('confirmed');
    expect(isCurrentChatOperation(nextSameConversation, fence)).toBe(false);
  });
});
