import { dismissSavedCard, requestSavedCardRefresh } from '@assistant/application/cards';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getAgentIdentity, getCardRefresh, getGeneratedCards } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid card id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'expectedRevisionId',
    'operationId',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as {
    action?: unknown;
    expectedRevisionId?: unknown;
    operationId?: unknown;
  } | null;
  if (body?.action !== 'dismiss' && body?.action !== 'refresh')
    return mobileJson({ error: 'action must be dismiss or refresh' }, { status: 400 });
  if (
    body.expectedRevisionId !== undefined &&
    (typeof body.expectedRevisionId !== 'string' ||
      body.expectedRevisionId.length < 1 ||
      body.expectedRevisionId.length > 128)
  )
    return mobileJson(
      { error: 'expectedRevisionId must be a bounded non-empty string' },
      { status: 400 },
    );
  if (
    body.operationId !== undefined &&
    (typeof body.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.operationId,
      ))
  )
    return mobileJson({ error: 'operationId must be a UUID' }, { status: 400 });
  const agent = await getAgentIdentity();
  if (body.action === 'refresh') {
    if (!agent.id) return mobileJson({ error: 'card not found' }, { status: 404 });
    const result = await requestSavedCardRefresh(
      getCardRefresh(),
      agent.id,
      id,
      undefined,
      body.operationId,
      body.expectedRevisionId,
    );
    return result.ok
      ? mobileJson(result, { status: 202 })
      : mobileJson({ error: result.error }, { status: result.status });
  }
  const dismissed = agent.id ? await dismissSavedCard(getGeneratedCards(), agent.id, id) : false;
  return dismissed
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'card not found' }, { status: 404 });
}
