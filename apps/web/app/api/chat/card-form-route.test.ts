import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticated: true,
  submit: vi.fn(),
}));
vi.mock('@/auth', () => ({ isAuthed: async () => mocks.authenticated }));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({ submitCardForm: mocks.submit }),
}));
vi.mock('ai', () => ({
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

import { POST } from './route';

const conversationId = '11111111-1111-4111-8111-111111111111';
const cardFormSubmission = {
  protocol: 'card-form-v1',
  conversationId,
  cardId: '22222222-2222-4222-8222-222222222222',
  expectedRevisionId: '33333333-3333-4333-8333-333333333333',
  formId: 'dinner',
  operationId: '55555555-5555-4555-8555-555555555555',
  values: { guests: '3' },
  ownerMessageText: 'Dinner details:\nNumber of guests: 3',
};
function request() {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-card-form': 'card-form-v1' },
    body: JSON.stringify({
      conversationId,
      clientOperationId: cardFormSubmission.operationId,
      autonomous: false,
      force: false,
      cardFormSubmission,
      messages: [
        {
          id: cardFormSubmission.operationId,
          role: 'user',
          parts: [{ type: 'text', text: cardFormSubmission.ownerMessageText }],
        },
      ],
    }),
  });
}

describe('card form chat route result contract', () => {
  beforeEach(() => {
    mocks.authenticated = true;
    mocks.submit.mockReset();
  });

  it('forwards only the typed definite stale-revision result', async () => {
    mocks.submit.mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'stale_revision',
      error: 'This card has changed.',
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: false,
      status: 409,
      reason: 'stale_revision',
      error: 'This card has changed.',
    });
  });

  it('forwards an owner-scoped active task pointer with its exact task status', async () => {
    mocks.submit.mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'active_form',
      activeTaskId: '66666666-6666-4666-8666-666666666666',
      taskStatus: 'waiting_approval',
      error: 'Another form is active.',
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: 'active_form',
      activeTaskId: '66666666-6666-4666-8666-666666666666',
      taskStatus: 'waiting_approval',
    });
  });

  it('keeps generic conflicts opaque and does not expose an unverified task pointer', async () => {
    mocks.submit.mockResolvedValue({ ok: false, status: 409, error: 'A conflict occurred.' });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'A conflict occurred.',
      code: 'invalid_card_form',
    });
  });

  it('does not call the admission service after owner authentication expires', async () => {
    mocks.authenticated = false;
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
