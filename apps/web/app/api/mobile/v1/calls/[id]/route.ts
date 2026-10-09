import { answerCallCheckin, getCall, hangUpCall } from '@assistant/application/calls';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getCallsPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID.test(id)) return mobileJson({ error: 'invalid call id' }, { status: 400 });
  const call = await getCall(await getCallsPorts(), id);
  return call ? mobileJson({ call }) : mobileJson({ error: 'call not found' }, { status: 404 });
}

/** Answer the assistant's live question, or hang up. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID.test(id)) return mobileJson({ error: 'invalid call id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'answer',
    'checkinId',
    'revision',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  const ports = await getCallsPorts();
  if (body?.action === 'hangup') {
    const result = await hangUpCall(ports, id);
    return result.ok
      ? mobileJson({ ok: true })
      : mobileJson({ error: result.error }, { status: 409 });
  }
  if (body?.action === 'answer') {
    if (
      typeof body.checkinId !== 'string' ||
      typeof body.revision !== 'number' ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1 ||
      typeof body.answer !== 'string'
    )
      return mobileJson({ error: 'checkinId, revision, and answer are required' }, { status: 400 });
    const result = await answerCallCheckin(ports, {
      callId: id,
      checkinId: body.checkinId,
      revision: body.revision,
      answer: body.answer,
      via: 'mobile',
    });
    return result.ok
      ? mobileJson({ ok: true })
      : mobileJson({ error: result.error }, { status: 409 });
  }
  return mobileJson({ error: 'action must be answer or hangup' }, { status: 400 });
}
