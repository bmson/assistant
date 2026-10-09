import { readBoundedJson } from '@assistant/application/http-body';
import { loadConfig } from '@assistant/config';
import { isAuthed } from '@/auth';
import {
  CHAT_OPERATION_CANCEL_MAX_BYTES,
  CHAT_OPERATION_CANCEL_MAX_DURATION_MS,
  conflictingChatOperationCancellation,
  parseChatOperationCancellationIdentity,
  projectChatOperationCancellation,
  unconfirmedChatOperationCancellation,
} from '@/lib/chat-operation-cancellation';
import { getChatApplication } from '@/lib/server';

export const dynamic = 'force-dynamic';

function sameConfiguredOrigin(request: Request): boolean {
  try {
    const config = loadConfig();
    const configured = new URL(config.AUTH_URL || config.PUBLIC_URL).origin;
    return request.headers.get('origin') === configured;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  // This cookie-authenticated mutation requires both the configured origin and
  // a verified owner session before the bounded body or application is read.
  if (!sameConfiguredOrigin(request))
    return Response.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  if (!(await isAuthed()))
    return Response.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );

  const body = await readBoundedJson(
    request,
    CHAT_OPERATION_CANCEL_MAX_BYTES,
    CHAT_OPERATION_CANCEL_MAX_DURATION_MS,
  );
  if (!body.ok)
    return Response.json(
      { error: body.error },
      { status: body.status, headers: { 'cache-control': 'no-store' } },
    );
  const identity = parseChatOperationCancellationIdentity(body.value);
  if (!identity)
    return Response.json(
      { error: 'Invalid chat cancellation identity.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );

  try {
    const result = await getChatApplication().cancelChatTurn(identity);
    const projected = projectChatOperationCancellation(identity, result);
    if (!projected)
      return Response.json(unconfirmedChatOperationCancellation(identity), {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    return Response.json(projected, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'chat not found')
      return Response.json(
        { ok: false, outcome: 'not_found', ...identity, taskId: null },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      );
    if (error instanceof Error && error.message.includes('already used for a different request'))
      return Response.json(conflictingChatOperationCancellation(identity), {
        status: 409,
        headers: { 'cache-control': 'no-store' },
      });
    // The transaction may have committed before a later read/transport failure.
    return Response.json(unconfirmedChatOperationCancellation(identity), {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
