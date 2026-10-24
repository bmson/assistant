'use server';

import {
  approveAndRememberApproval,
  decideApproval,
  decideApprovals,
} from '@assistant/application/approvals';
import {
  approveOwnerCallNumberGrant,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
  type OwnerCallGrantPreviewResult,
  previewOwnerCallNumberGrant,
} from '@assistant/application/phone-call-owner-grants';
import { revalidatePath } from 'next/cache';
import { deletePolicy, setPolicyEnabled } from '@/app/settings/actions';
import { requireOwner } from '@/auth';
import { withApprovalDecisionStore } from '@/lib/approval-store';

function revalidateApprovalViews(): void {
  revalidatePath('/');
  revalidatePath('/approvals');
  revalidatePath('/tasks');
  revalidatePath('/chat', 'layout');
}

export async function approveApproval(approvalId: string): Promise<void> {
  await requireOwner();
  await withApprovalDecisionStore((store) => decideApproval(store, approvalId, 'approved'));
  revalidateApprovalViews();
}

export async function denyApproval(approvalId: string): Promise<void> {
  await requireOwner();
  await withApprovalDecisionStore((store) => decideApproval(store, approvalId, 'denied'));
  revalidateApprovalViews();
}

export async function resolveApprovalInline(
  approvalId: string,
  decision: 'approved' | 'denied',
  remember = false,
): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const result = await withApprovalDecisionStore((store) =>
    remember && decision === 'approved'
      ? approveAndRememberApproval(store, approvalId)
      : decideApproval(store, approvalId, decision),
  );
  if (result.ok && remember) revalidatePath('/settings');
  revalidateApprovalViews();
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}

/**
 * Resolve several approvals in one server round trip ("Approve all" on a
 * grouped chat card). Sequential on purpose — resolveApproval wakes the parked
 * task per approval — and per-id failures are reported, not thrown, so one
 * expired approval doesn't strand the rest.
 */
export async function resolveApprovalsInline(
  approvalIds: string[],
  decision: 'approved' | 'denied',
): Promise<{ failures: Array<{ approvalId: string; error: string }> }> {
  await requireOwner();
  const failures = await withApprovalDecisionStore((store) =>
    decideApprovals(store, approvalIds, decision),
  );
  revalidateApprovalViews();
  return { failures };
}

/** Approve and save the supported standing rule derived from the current request. */
export async function approveAndRemember(approvalId: string): Promise<void> {
  await requireOwner();
  const result = await withApprovalDecisionStore((store) =>
    approveAndRememberApproval(store, approvalId),
  );
  if (!result.ok) throw new Error(result.reason);
  revalidatePath('/settings');
  revalidateApprovalViews();
}

export interface EditApproveState {
  error: string | null;
  /** Raw textarea content echoed back on error so the user's edit isn't lost on reset. */
  raw?: string;
}

/** Edit-then-approve: validate the edited JSON, then resolve with editedPayload. */
export async function editAndApprove(
  _prev: EditApproveState,
  formData: FormData,
): Promise<EditApproveState> {
  await requireOwner();
  const approvalId = String(formData.get('approvalId') ?? '');
  const raw = String(formData.get('payload') ?? '');

  let editedPayload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Payload must be a JSON object.', raw };
    }
    editedPayload = parsed as Record<string, unknown>;
  } catch {
    return { error: 'Invalid JSON — fix the payload and submit again.', raw };
  }

  const result = await withApprovalDecisionStore((store) =>
    decideApproval(store, approvalId, 'approved', editedPayload),
  );
  if (!result.ok) return { error: `Could not approve: ${result.reason}`, raw };

  revalidateApprovalViews();
  return { error: null };
}

export type OwnerCallGrantActionState = {
  error: string | null;
  preview: Extract<OwnerCallGrantPreviewResult, { ok: true }> | null;
  completed: boolean;
};

const emptyOwnerCallGrantActionState: OwnerCallGrantActionState = {
  error: null,
  preview: null,
  completed: false,
};

export async function ownerCallNumberGrantAction(
  approvalId: string,
  _previous: OwnerCallGrantActionState,
  formData: FormData,
): Promise<OwnerCallGrantActionState> {
  await requireOwner();
  const keys = [...new Set([...formData.keys()])];
  const mode = String(formData.get('mode') ?? '');
  if (keys.some((key) => formData.getAll(key).length !== 1))
    return {
      ...emptyOwnerCallGrantActionState,
      error: 'This review expired or changed. Review again.',
    };
  if (mode === 'review') {
    if (keys.some((key) => !['mode', 'action', 'validityChoice'].includes(key)))
      return { ...emptyOwnerCallGrantActionState, error: 'Review this call again.' };
    const choice = String(formData.get('validityChoice') ?? '');
    const validityDays = ({ '24h': 1, '7d': 7, '30d': 30 } as const)[
      choice as '24h' | '7d' | '30d'
    ];
    if (formData.get('action') !== 'preview_reusable_call_v1' || !validityDays)
      return {
        ...emptyOwnerCallGrantActionState,
        error: 'Choose a supported permission duration.',
      };
    const result = await withApprovalDecisionStore((store) =>
      previewOwnerCallNumberGrant(store, approvalId, validityDays),
    );
    return result.ok
      ? { error: null, preview: result, completed: false }
      : { ...emptyOwnerCallGrantActionState, error: result.reason };
  }
  if (
    mode !== 'approve' ||
    keys.some(
      (key) => !['mode', 'action', 'reviewToken', 'acknowledgement', 'confirmation'].includes(key),
    ) ||
    String(formData.get('action') ?? '') !== 'approve_reusable_call_v1' ||
    String(formData.get('acknowledgement') ?? '') !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT ||
    String(formData.get('confirmation') ?? '') !== 'confirmed'
  )
    return { ...emptyOwnerCallGrantActionState, error: 'Review this call again.' };
  try {
    const reviewToken = String(formData.get('reviewToken') ?? '');
    const result = await withApprovalDecisionStore((store) =>
      approveOwnerCallNumberGrant(store, approvalId, reviewToken, OWNER_CALL_GRANT_ACKNOWLEDGEMENT),
    );
    if (!result.ok)
      return {
        ...emptyOwnerCallGrantActionState,
        error: result.reason.includes('expired or changed')
          ? 'This review expired or changed. Review again.'
          : 'Could not confirm result. Refresh to check this call and saved permission before trying again.',
      };
    revalidatePath('/settings');
    revalidateApprovalViews();
    return { error: null, preview: null, completed: true };
  } catch {
    return {
      ...emptyOwnerCallGrantActionState,
      error:
        'Could not confirm result. Refresh to check this call and saved permission before trying again.',
    };
  }
}

export async function pauseSavedCallPermission(policyId: string): Promise<void> {
  await setPolicyEnabled(policyId, false);
  revalidateApprovalViews();
}

export async function deleteSavedCallPermission(policyId: string): Promise<void> {
  await deletePolicy(policyId);
  revalidateApprovalViews();
}
