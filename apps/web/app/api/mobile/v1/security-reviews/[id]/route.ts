import {
  decideOwnerSecurityIncident,
  isSecurityIncidentId,
} from '@assistant/application/security-incidents';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getEmailObligationRepository } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'expectedRevision',
    'disposition',
    'reason',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const { id } = await params;
  if (!isSecurityIncidentId(id))
    return mobileJson({ error: 'invalid security incident id' }, { status: 400 });
  const body = mutationBody.value;
  if (
    typeof body.expectedRevision !== 'number' ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1 ||
    (body.disposition !== 'expected' && body.disposition !== 'dismissed') ||
    typeof body.reason !== 'string' ||
    !body.reason.trim() ||
    body.reason.length > 500
  )
    return mobileJson({ error: 'invalid security incident decision' }, { status: 400 });

  const repository = getEmailObligationRepository();
  const { agentId } = await repository.mailbox();
  const result = await decideOwnerSecurityIncident(repository, agentId, {
    incidentId: id,
    expectedRevision: body.expectedRevision as number,
    disposition: body.disposition,
    reason: body.reason,
  });
  if (!result.ok)
    return mobileJson(
      { error: 'This security notice changed or is no longer available. Refresh and review it.' },
      { status: 409 },
    );
  return mobileJson({ ok: true });
}
