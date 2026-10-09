import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { proposalCodeFixReceipt, requestOwnerProposalCodeFix } from '@/lib/proposal-code-fix';
import { decideOwnerImprovement } from '@/lib/workspace-reviews';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid proposal id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { action?: unknown } | null;
  try {
    if (body?.action === 'request_fix') {
      const issue = await requestOwnerProposalCodeFix(id);
      return mobileJson({ ok: true, ...proposalCodeFixReceipt(issue) });
    }
    if (body?.action !== 'apply' && body?.action !== 'dismiss')
      return mobileJson({ error: 'action must be apply, dismiss or request_fix' }, { status: 400 });
    const result = await decideOwnerImprovement(id, body.action);
    return mobileJson({ ok: true, ...result });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Proposal could not be updated.' },
      { status: 409 },
    );
  }
}
