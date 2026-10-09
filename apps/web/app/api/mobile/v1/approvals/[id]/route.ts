import { approveAndRememberApproval, decideApproval } from '@assistant/application/approvals';
import { withApprovalDecisionStore } from '@/lib/approval-store';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid approval id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action', 'decision', 'payload']);
  if (!mutationBody.ok) return mutationBody.response;

  const body = mutationBody.value as {
    action?: unknown;
    decision?: unknown;
    payload?: unknown;
  } | null;
  if (body?.action === 'remember') {
    const result = await withApprovalDecisionStore((store) =>
      approveAndRememberApproval(store, id),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (body?.action === 'edit') {
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      return mobileJson({ error: 'payload must be a JSON object' }, { status: 400 });
    }
    const result = await withApprovalDecisionStore((store) =>
      decideApproval(store, id, 'approved', body.payload as Record<string, unknown>),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (body?.decision !== 'approved' && body?.decision !== 'denied') {
    return mobileJson(
      { error: 'decision must be approved or denied, or action must be remember or edit' },
      { status: 400 },
    );
  }
  const result = await withApprovalDecisionStore((store) =>
    decideApproval(store, id, body.decision as 'approved' | 'denied'),
  );
  return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
}
