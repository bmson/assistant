import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), submit: vi.fn() }));
vi.mock('@/lib/server', () => ({ getChatApplication: () => ({ submitCardForm: mocks.submit }) }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const submission = {
  protocol: 'card-form-v1',
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cardId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  formId: 'trip_plan',
  operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  values: { destination: 'Portland', confirmed: false },
  ownerMessageText: 'Plan a weekend in Portland.',
} as const;

function post(body: unknown = submission): Promise<Response> {
  return POST(
    new Request('https://assistant.test/api/mobile/v1/chat/forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
});

describe('mobile generated-card form admission', () => {
  it('authenticates before reading or admitting a request', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await post({ malformed: true });
    expect(response.status).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('rejects bodies above the 16 KiB admission budget before service access', async () => {
    const response = await post({ ...submission, extra: 'x'.repeat(16 * 1024) });
    expect(response.status).toBe(413);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('rejects extra client authority and malformed values through the strict shared schema', async () => {
    expect((await post({ ...submission, ownerId: 'attacker' })).status).toBe(422);
    expect((await post({ ...submission, values: { destination: 17 } })).status).toBe(422);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('returns the durable accepted task receipt without accepting an owner ID', async () => {
    const receipt = {
      ok: true,
      created: true,
      taskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      messageId: '11111111-1111-4111-8111-111111111111',
      messageCursor: '2026-10-08T12:00:00.000Z|11111111-1111-4111-8111-111111111111',
      taskStatus: 'pending',
      queueGeneration: 1,
      dispatch: 'outbox',
    };
    mocks.submit.mockResolvedValue(receipt);
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(receipt);
    expect(mocks.submit).toHaveBeenCalledWith(submission);
  });

  it('replays the same operation and returns the original receipt without a second admission', async () => {
    const receipt = {
      ok: true,
      created: false,
      taskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      messageId: '11111111-1111-4111-8111-111111111111',
      messageCursor: '2026-10-08T12:00:00.000Z|11111111-1111-4111-8111-111111111111',
      taskStatus: 'pending',
      queueGeneration: 1,
      dispatch: null,
    };
    mocks.submit.mockResolvedValue(receipt);
    const first = await post(submission);
    const replay = await post(submission);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(mocks.submit).toHaveBeenNthCalledWith(1, submission);
    expect(mocks.submit).toHaveBeenNthCalledWith(2, submission);
  });

  it('preserves definite stale-revision and active-operation conflicts', async () => {
    mocks.submit
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        reason: 'stale_revision',
        error: 'Refresh this card before sending.',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        reason: 'active_form',
        activeTaskId: '22222222-2222-4222-8222-222222222222',
        taskStatus: 'running',
        error: 'This form is already being handled.',
      });
    const stale = await post();
    const active = await post({
      ...submission,
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: 'stale_revision' });
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({
      reason: 'active_form',
      activeTaskId: '22222222-2222-4222-8222-222222222222',
    });
  });
  it('keeps a failure after service access unconfirmed so the client replays the same operation', async () => {
    mocks.submit.mockRejectedValue(new Error('Readback failed after commit'));
    const response = await post();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBeUndefined();
    expect(body.reason).toBeUndefined();
    expect(mocks.submit).toHaveBeenCalledWith(submission);
  });
});
