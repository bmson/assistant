import { readBoundedJson } from '@assistant/application/http-body';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { isAuthed } from '@/auth';
import { getChatApplication } from '@/lib/server';
import { parseCardFormChatRequest } from './card-form-request';

const MAX_FORM_BODY_BYTES = 16 * 1024;
const TASK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidFormRequest(error: string, status = 400): Response {
  return Response.json({ error, code: 'invalid_card_form' }, { status });
}

async function handleCardFormTurn(request: Request): Promise<Response> {
  const bounded = await readBoundedJson(request, MAX_FORM_BODY_BYTES);
  if (!bounded.ok) return invalidFormRequest(bounded.error, bounded.status);
  const submission = parseCardFormChatRequest(bounded.value);
  if (!submission) return invalidFormRequest('Review the form and message before sending.');

  const result = await getChatApplication().submitCardForm(submission);
  if (!result.ok) {
    if (result.reason === 'stale_revision') {
      return Response.json(
        {
          ok: false,
          status: 409,
          reason: 'stale_revision',
          error: result.error,
        },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      );
    }
    if (result.reason === 'active_form') {
      if (
        !TASK_UUID.test(result.activeTaskId) ||
        !result.taskStatus ||
        result.taskStatus.length > 40
      )
        return invalidFormRequest('The active form task receipt is invalid.', 409);
      return Response.json(
        {
          ok: false,
          status: 409,
          reason: 'active_form',
          activeTaskId: result.activeTaskId,
          taskStatus: result.taskStatus,
          error: result.error,
        },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      );
    }
    return invalidFormRequest(result.error, result.status);
  }
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'data-task-accepted',
        data: { taskId: result.taskId },
        transient: true,
      });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-conversation-id': submission.conversationId,
      'x-owner-message-id': result.messageId,
      'x-async-task': result.taskId,
      'x-message-cursor': result.messageCursor,
      'cache-control': 'no-store',
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return Response.json(
      { error: 'Your session expired — sign in again, then resend.', code: 'unauthorized' },
      { status: 401 },
    );
  }
  const protocol = request.headers.get('x-chat-card-form');
  if (protocol && protocol !== 'card-form-v1')
    return invalidFormRequest('This form protocol is not supported.');
  if (protocol === 'card-form-v1') return handleCardFormTurn(request);
  return getChatApplication().handleChatTurn(request);
}
