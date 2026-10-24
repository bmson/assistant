import { approveAndRememberApproval, decideApproval } from '@assistant/application/approvals';
import {
  approveOwnerCallNumberGrant,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
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
  ]);
  if (!mutationBody.ok) return mutationBody.response;

  const body = mutationBody.value;
  const keys = Object.keys(body).sort();
  if (body.action === 'preview_reusable_call_v1' || body.action === 'approve_reusable_call_v1') {
    if (body.action === 'preview_reusable_call_v1') {
      if (
        keys.length !== 2 ||
        keys[0] !== 'action' ||
        keys[1] !== 'validityChoice' ||
        typeof body.validityChoice !== 'string' ||
        !['24h', '7d', '30d'].includes(body.validityChoice)
      )
        return mobileJson({ error: 'invalid review request' }, { status: 400 });
      const result = await withApprovalDecisionStore((store) =>
        previewOwnerCallNumberGrant(
          store,
          id,
          ({ '24h': 1, '7d': 7, '30d': 30 } as const)[body.validityChoice as '24h' | '7d' | '30d'],
        ),
      );
      return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
    }

    if (
      body.action !== 'approve_reusable_call_v1' ||
      keys.length !== 3 ||
      keys[0] !== 'acknowledgement' ||
      keys[1] !== 'action' ||
      keys[2] !== 'reviewToken' ||
      body.acknowledgement !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT ||
      typeof body.reviewToken !== 'string' ||
      body.reviewToken.length === 0
    )
      return mobileJson({ error: 'invalid approval confirmation' }, { status: 400 });

    const result = await withApprovalDecisionStore((store) =>
      approveOwnerCallNumberGrant(
        store,
        id,
        body.reviewToken as string,
        body.acknowledgement as string,
      ),
    );
    return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
  }
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
