import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getChatApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hiding a message is a soft-hide: the row stays, the log query and the
 * model's conversation history both skip it. That is why this is a POST
 * toggle rather than a DELETE — the owner can always undo a hide, and
 * nothing else that references the message (cards, approvals) breaks.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id, messageId } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid chat id' }, { status: 400 });
  if (!UUID_RE.test(messageId)) {
    return mobileJson({ error: 'invalid message id' }, { status: 400 });
  }
  const mutationBody = await readMobileMutationBody(request, ['action', 'clientId']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { action?: unknown; clientId?: unknown } | null;
  if (body?.action !== 'hide' && body?.action !== 'unhide' && body?.action !== 'delivered') {
    return mobileJson({ error: 'action must be hide, unhide, or delivered' }, { status: 400 });
  }
  if (body.action === 'delivered') {
    if (!/^Bearer\s+\S+/i.test(request.headers.get('authorization') ?? ''))
      return mobileUnauthorized();
    if (typeof body.clientId !== 'string' || !UUID_RE.test(body.clientId))
      return mobileJson({ error: 'clientId must be a UUID' }, { status: 400 });
  }
  try {
    if (body.action === 'delivered') {
      const ok = await getChatApplication().acknowledgeMessageDelivery(
        id,
        messageId,
        body.clientId as string,
      );
      return ok
        ? mobileJson({ ok: true })
        : mobileJson({ error: 'delivery receipt could not be recorded yet' }, { status: 409 });
    }
    const ok =
      body.action === 'hide'
        ? await getChatApplication().hideChatMessage(id, messageId)
        : await getChatApplication().unhideChatMessage(id, messageId);
    if (!ok) return mobileJson({ error: 'message not found' }, { status: 404 });
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Message could not be updated.' },
      { status: 409 },
    );
  }
}
