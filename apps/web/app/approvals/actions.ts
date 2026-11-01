'use server';

import {
  approveAndRememberApproval,
  decideApproval,
  decideApprovals,
} from '@assistant/application/approvals';
import {
  approveOwnerCallNumberGrant,
  checkOwnerCallGrantOperation,
  closeOwnerCallGrantOperation,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
  OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
  type OwnerCallGrantOperationStatus,
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
  operation?: OwnerCallGrantOperationStatus | null;
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
  const invalid = () => ({
    ...emptyOwnerCallGrantActionState,
    error: 'Review this permission again.',
  });
  if (keys.some((key) => formData.getAll(key).length !== 1)) return invalid();
  if (mode === 'check') {
    if (
      keys.some((key) => !['mode', 'action'].includes(key)) ||
      formData.get('action') !== 'check_reusable_call_v2'
    )
      return invalid();
    const operation = await withApprovalDecisionStore((store) =>
      checkOwnerCallGrantOperation(store, approvalId),
    );
    return {
      ...emptyOwnerCallGrantActionState,
      operation,
      error: operation.ok ? null : operation.reason,
    };
  }
  if (mode === 'close') {
    if (
      keys.some((key) => !['mode', 'action', 'closeToken', 'confirmation'].includes(key)) ||
      formData.get('action') !== 'close_reusable_call_v2' ||
      formData.get('confirmation') !== 'confirmed'
    )
      return invalid();
    const operation = await withApprovalDecisionStore((store) =>
      closeOwnerCallGrantOperation(
        store,
        approvalId,
        String(formData.get('closeToken') ?? ''),
        OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
      ),
    );
    return {
      ...emptyOwnerCallGrantActionState,
      operation,
      error: operation.ok ? null : operation.reason,
    };
  }
  if (mode === 'review') {
    const fields = [
      'mode',
      'action',
      'validityChoice',
      'callsPerHour',
      'callsPerDay',
      'usdPerCall',
      'usdPerDay',
    ];
    if (
      keys.some((key) => !fields.includes(key)) ||
      fields.some((key) => !keys.includes(key)) ||
      formData.get('action') !== 'preview_reusable_call_v2'
    )
      return invalid();
    const validityDays = ({ '24h': 1, '7d': 7, '30d': 30 } as const)[
      String(formData.get('validityChoice')) as '24h' | '7d' | '30d'
    ];
    const integer = (name: string) =>
      /^\d{1,3}$/.test(String(formData.get(name))) ? Number(formData.get(name)) : NaN;
    const micros = (name: string) => {
      const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(String(formData.get(name)));
      return match
        ? Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(2, '0')) * 10_000
        : NaN;
    };
    if (!validityDays) return invalid();
    const result = await withApprovalDecisionStore((store) =>
      previewOwnerCallNumberGrant(store, approvalId, validityDays, {
        maxCallsPerHour: integer('callsPerHour'),
        maxCallsPerDay: integer('callsPerDay'),
        maxCostUsdMicrosPerCall: micros('usdPerCall'),
        maxCostUsdMicrosPerDay: micros('usdPerDay'),
      }),
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
    formData.get('action') !== 'approve_reusable_call_v2' ||
    formData.get('acknowledgement') !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT ||
    formData.get('confirmation') !== 'confirmed'
  )
    return invalid();
  try {
    const result = await withApprovalDecisionStore((store) =>
      approveOwnerCallNumberGrant(
        store,
        approvalId,
        String(formData.get('reviewToken') ?? ''),
        OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
      ),
    );
    if (!result.ok) return { ...emptyOwnerCallGrantActionState, error: result.reason };
    revalidatePath('/settings');
    revalidateApprovalViews();
    return { error: null, preview: null, completed: true };
  } catch {
    return {
      ...emptyOwnerCallGrantActionState,
      error: 'The result is not confirmed. Check this permission operation before reviewing again.',
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
