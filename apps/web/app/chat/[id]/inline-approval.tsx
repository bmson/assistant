'use client';

import type { InlineApprovalDetail, InlineApprovalStatus } from '@assistant/application/chat';
import { Check, CircleHelp, X } from 'lucide-react';
import { AlwaysApproveButton } from '@/app/approvals/always-approve-button';
import { ConfirmButton } from '@/lib/ui-client';
import { DecisionActions, DecisionReceipt } from './decision-card';

export interface InlineApprovalPart {
  type: 'approval';
  approvalId: string;
  shortCode: string;
  summary: string;
  status?: InlineApprovalStatus;
  details?: InlineApprovalDetail[];
  rememberLabel?: string | null;
}

/** What the group decided about a row in this session, layered over the server status. */
export type RowResolution = 'approved' | 'denied' | undefined;

/**
 * One approval inside an <ApprovalGroup>. Presentational: the group owns all
 * server calls and resolution state so per-row buttons stay coherent. Pending
 * rows carry actions; settled rows collapse to the shared receipt.
 */
export function ApprovalRow({
  part,
  resolution,
  busy,
  busyDecision,
  disabled,
  detailsOpenByDefault,
  onResolve,
}: {
  part: InlineApprovalPart;
  resolution: RowResolution;
  busy: boolean;
  busyDecision: 'approved' | 'denied' | null;
  disabled: boolean;
  detailsOpenByDefault: boolean;
  onResolve: (approvalId: string, decision: 'approved' | 'denied', remember?: boolean) => void;
}) {
  const status: InlineApprovalStatus = resolution ?? part.status ?? 'pending';

  if (status !== 'pending') {
    // Answered here a moment ago, rather than read back from the row: say so,
    // and say the work is moving again.
    const justNow = resolution !== undefined;
    return (
      <DecisionReceipt
        outcome={
          status === 'approved'
            ? 'accepted'
            : status === 'denied'
              ? 'declined'
              : status === 'expired'
                ? 'lapsed'
                : 'dismissed'
        }
        summary={part.summary}
        verdict={
          status === 'approved'
            ? justNow
              ? 'Approved — resuming'
              : 'Approved'
            : status === 'denied'
              ? 'Declined'
              : status === 'expired'
                ? 'Expired'
                : 'No longer available'
        }
        title={`${part.shortCode} · ${part.summary}`}
        live={justNow}
      />
    );
  }

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p className="min-w-0 flex-[1_1_12rem] break-words text-sm font-medium [overflow-wrap:anywhere]">
          {part.summary}
        </p>
        <span
          className="ml-auto inline-flex max-w-full min-w-0 shrink items-center gap-1 rounded-full bg-sunken px-2 py-1 font-mono text-xs font-medium text-muted whitespace-normal [overflow-wrap:anywhere]"
          title="Reference code used for this same request in chat, notifications, and activity."
        >
          Ref {part.shortCode}
          <CircleHelp className="size-3" aria-hidden="true" />
        </span>
      </div>
      {part.details && part.details.length > 0 ? (
        <details open={detailsOpenByDefault} className="mt-2 border-y border-edge py-2.5">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs leading-5 font-medium text-muted select-none">
            Exact details
          </summary>
          <dl className="mt-2 flex max-h-64 flex-col gap-2 overscroll-contain overflow-y-auto">
            {part.details.map((detail, index) => (
              <div key={`${detail.label}-${index.toString()}`}>
                <dt className="text-xs font-medium text-muted">{detail.label}</dt>
                <dd className="mt-0.5 text-xs break-words whitespace-pre-wrap text-strong [overflow-wrap:anywhere]">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <DecisionActions>
        <ConfirmButton
          variant="primary"
          size="sm"
          disabled={disabled}
          pending={busy && busyDecision === 'approved'}
          pendingLabel="Approving…"
          confirmLabel="Approve?"
          onConfirm={() => onResolve(part.approvalId, 'approved')}
        >
          <Check aria-hidden="true" />
          Approve
        </ConfirmButton>
        <ConfirmButton
          variant="outline"
          size="sm"
          disabled={disabled}
          pending={busy && busyDecision === 'denied'}
          pendingLabel="Denying…"
          confirmLabel="Deny?"
          onConfirm={() => onResolve(part.approvalId, 'denied')}
        >
          <X aria-hidden="true" />
          Deny
        </ConfirmButton>
        {part.rememberLabel ? (
          <AlwaysApproveButton
            scope={part.rememberLabel}
            size="sm"
            disabled={disabled}
            pending={busy && busyDecision === 'approved'}
            onConfirm={() => onResolve(part.approvalId, 'approved', true)}
          />
        ) : null}
      </DecisionActions>
    </div>
  );
}
