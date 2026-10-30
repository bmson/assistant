import { approveAndRememberApproval, decideApproval } from '@assistant/application/approvals';
import {
  approveOwnerCallNumberGrant,
  checkOwnerCallGrantOperation,
  closeOwnerCallGrantOperation,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
  OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
  OwnerCallGrantLimitsSchema,
  previewOwnerCallNumberGrant,
} from '@assistant/application/phone-call-owner-grants';
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
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'decision',
    'payload',
    'validityChoice',
    'reviewToken',
    'acknowledgement',
    'limits',
    'closeToken',
    'confirmation',
  ]);
  if (!mutationBody.ok) return mutationBody.response;

  const body = mutationBody.value;
  const keys = Object.keys(body).sort();
  const exact = (expected: string[]) => keys.join(',') === expected.sort().join(',');
  if (body.action === 'check_reusable_call_v2') {
    if (!exact(['action']))
      return mobileJson({ error: 'invalid operation check' }, { status: 400 });
    const result = await withApprovalDecisionStore((store) =>
      checkOwnerCallGrantOperation(store, id),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (body.action === 'close_reusable_call_v2') {
    if (
      !exact(['action', 'acknowledgement', 'closeToken', 'confirmation']) ||
      body.acknowledgement !== OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT ||
      body.confirmation !== 'confirmed' ||
      typeof body.closeToken !== 'string'
    )
      return mobileJson({ error: 'invalid close confirmation' }, { status: 400 });
    const result = await withApprovalDecisionStore((store) =>
      closeOwnerCallGrantOperation(
        store,
        id,
        body.closeToken as string,
        OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
      ),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (body.action === 'preview_reusable_call_v2') {
    const limits = OwnerCallGrantLimitsSchema.safeParse(body.limits);
    if (
      !exact(['action', 'limits', 'validityChoice']) ||
      !limits.success ||
      typeof body.validityChoice !== 'string' ||
      !['24h', '7d', '30d'].includes(body.validityChoice)
    )
      return mobileJson({ error: 'invalid review limits' }, { status: 400 });
    const result = await withApprovalDecisionStore((store) =>
      previewOwnerCallNumberGrant(
        store,
        id,
        ({ '24h': 1, '7d': 7, '30d': 30 } as const)[body.validityChoice as '24h' | '7d' | '30d'],
        limits.data,
      ),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (body.action === 'approve_reusable_call_v2') {
    if (
      !exact(['action', 'acknowledgement', 'reviewToken']) ||
      body.acknowledgement !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT ||
      typeof body.reviewToken !== 'string'
    )
      return mobileJson({ error: 'invalid approval confirmation' }, { status: 400 });
    const result = await withApprovalDecisionStore((store) =>
      approveOwnerCallNumberGrant(
        store,
        id,
        body.reviewToken as string,
        OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
      ),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
  if (typeof body.action === 'string' && body.action.includes('reusable_call'))
    return mobileJson(
      { error: 'unsupported permission protocol; approve only this call instead' },
      { status: 400 },
    );
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
