import { readBoundedJson } from '@assistant/application/http-body';
import {
  CHAT_OPERATION_CANCEL_MAX_BYTES,
  CHAT_OPERATION_CANCEL_MAX_DURATION_MS,
  conflictingChatOperationCancellation,
  parseChatOperationCancellationIdentity,
  projectChatOperationCancellation,
  unconfirmedChatOperationCancellation,
} from '@/lib/chat-operation-cancellation';
import { getChatApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await readBoundedJson(
    request,
    CHAT_OPERATION_CANCEL_MAX_BYTES,
    CHAT_OPERATION_CANCEL_MAX_DURATION_MS,
  );
  if (!body.ok) return mobileJson({ error: body.error }, { status: body.status });
  const identity = parseChatOperationCancellationIdentity(body.value);
  if (!identity)
    return mobileJson({ error: 'Invalid chat cancellation identity.' }, { status: 400 });

  try {
    const result = await getChatApplication().cancelChatTurn(identity);
    const projected = projectChatOperationCancellation(identity, result);
    if (!projected)
      return mobileJson(unconfirmedChatOperationCancellation(identity), { status: 503 });
    return mobileJson(projected);
  } catch (error) {
    if (error instanceof Error && error.message === 'chat not found')
      return mobileJson(
        { ok: false, outcome: 'not_found', ...identity, taskId: null },
        { status: 404 },
      );
    if (error instanceof Error && error.message.includes('already used for a different request'))
      return mobileJson(conflictingChatOperationCancellation(identity), { status: 409 });
    // This may be a lost response after the durable transaction committed.
    return mobileJson(unconfirmedChatOperationCancellation(identity), { status: 503 });
  }
}
