import { describe, expect, it } from 'vitest';
import { parseCardFormChatRequest } from './card-form-request';

const submission = {
  protocol: 'card-form-v1',
  conversationId: '11111111-1111-4111-8111-111111111111',
  cardId: '22222222-2222-4222-8222-222222222222',
  expectedRevisionId: '33333333-3333-4333-8333-333333333333',
  formId: 'event',
  operationId: '55555555-5555-4555-8555-555555555555',
  values: { confirmed: false },
  ownerMessageText: 'Please plan the event.',
};
const body = {
  conversationId: submission.conversationId,
  clientOperationId: submission.operationId,
  autonomous: false,
  force: false,
  cardFormSubmission: submission,
  messages: [
    {
      id: submission.operationId,
      role: 'user',
      parts: [{ type: 'text', text: submission.ownerMessageText }],
    },
  ],
};

describe('card form chat protocol', () => {
  it('admits only the exact one-message owner text paired with the form operation', () => {
    expect(parseCardFormChatRequest(body)).toEqual(submission);
    expect(
      parseCardFormChatRequest({ ...body, messages: [...body.messages, ...body.messages] }),
    ).toBeNull();
    expect(
      parseCardFormChatRequest({
        ...body,
        clientOperationId: '66666666-6666-4666-8666-666666666666',
      }),
    ).toBeNull();
    expect(parseCardFormChatRequest({ ...body, force: true })).toBeNull();
    expect(
      parseCardFormChatRequest({
        ...body,
        messages: [{ ...body.messages[0], parts: [{ type: 'text', text: 'Different message' }] }],
      }),
    ).toBeNull();
  });
});
