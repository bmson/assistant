'use client';

import {
  ArrowUpRight,
  CalendarDays,
  Check,
  FileText,
  Globe2,
  Mail,
  MessageSquareText,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  approveAndRemember,
  approveApproval,
  denyApproval,
  editAndApprove,
} from '@/app/approvals/actions';
import { AlwaysApproveButton } from '@/app/approvals/always-approve-button';
import { OwnerCallNumberGrant } from '@/app/approvals/owner-call-number-grant';
import {
  btn,
  cardBodyClass,
  cardFooterClass,
  cardInteractiveClass,
  cardShellClass,
  cardTitleClass,
  InfoGrid,
  InfoItem,
  MetaLine,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';
import type { PendingApprovalView } from '@/lib/views';

const actionIcons = {
  email: Mail,
  calendar: CalendarDays,
  message: MessageSquareText,
  document: FileText,
  browser: Globe2,
  action: ShieldCheck,
} as const;

const actionLabels = {
  email: 'Email',
  calendar: 'Calendar change',
  message: 'Message',
  document: 'Document change',
  browser: 'Browser action',
  action: 'External action',
} as const;

export function ApprovalCard({
  approval,
  compact = false,
}: {
  approval: PendingApprovalView;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(editAndApprove, {
    error: null,
  });
  const ActionIcon = actionIcons[approval.actionKind];
  const actionLabel = actionLabels[approval.actionKind];

  return (
    <article className={`${cardShellClass} ${cardInteractiveClass} @container/approval`}>
      <div className={cardBodyClass}>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ActionIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-accent">{actionLabel} · waiting for you</p>
            <h3 className={`mt-1 ${cardTitleClass}`}>{approval.summary}</h3>
            {/* Provenance and timing are context, not content — one quiet line,
                with exact timestamps on hover, instead of a grid of cells that
                competed with what is actually being approved below. */}
            <MetaLine
              className="mt-1.5"
              segments={[
                approval.provenance,
                <span key="requested" title={approval.requestedExact}>
                  {approval.requestedLabel}
                </span>,
                <span key="expires" title={approval.expiresExact}>
                  {approval.expiresLabel}
                </span>,
                <span
                  key="code"
                  className="font-mono"
                  title="A short identifier for recognizing this request in chat, text messages, and activity."
                >
                  {approval.shortCode}
                </span>,
                <Link
                  key="task"
                  href={`/tasks/${approval.taskId}`}
                  className="inline-flex items-center gap-0.5 hover:text-strong"
                >
                  View activity
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>,
              ]}
            />
          </div>
        </div>
        {approval.voiceFlag ? (
          <div className="rounded-xl bg-amber-100/80 px-3 py-2.5 dark:bg-amber-950/45">
            <p className="flex items-center gap-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Voice rewrite failed fact-check — original draft shown
            </p>
            <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
              {approval.voiceFlag}
            </p>
          </div>
        ) : null}
        {approval.fields.length > 0 && (!compact || approval.fields.length <= 5) ? (
          <InfoGrid columns={1} className="sm:grid-cols-2">
            {approval.fields.map((f) => (
              <InfoItem key={f.label} label={f.label} className={f.block ? 'sm:col-span-2' : ''}>
                <span className={f.block ? 'whitespace-pre-wrap' : ''}>{f.value}</span>
              </InfoItem>
            ))}
          </InfoGrid>
        ) : null}
        {/* One disclosure, not two side-by-side panels: the why and the exact
            payload are both "more detail", and a deciding owner opens them
            together or not at all. */}
        <details className="rounded-xl bg-sunken/45 px-3 py-2.5">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs font-medium text-muted select-none">
            Why this asks, and the exact request
          </summary>
          <p className="mt-2 max-w-[72ch] text-xs leading-5 text-muted">{approval.reason}</p>
          <pre className="mt-2 overscroll-x-contain overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-xs">
            {approval.payloadJson}
          </pre>
        </details>
        {approval.ownerNumberGrantAvailable ? (
          <OwnerCallNumberGrant
            key={approval.ownerNumberGrantSourceFingerprint ?? approval.payloadJson}
            approvalId={approval.id}
            sourceFingerprint={approval.ownerNumberGrantSourceFingerprint ?? approval.payloadJson}
          />
        ) : null}
      </div>

      {approval.expired ? (
        <p className="border-t border-edge bg-sunken/55 px-4 py-3 text-sm font-medium text-muted sm:px-5">
          This request has expired. Open its activity if you still want the assistant to try again.
        </p>
      ) : editing ? (
        <form action={editAction} className="border-t border-edge bg-sunken/45 p-4 sm:p-5">
          <input type="hidden" name="approvalId" value={approval.id} />
          <label htmlFor={`approval-payload-${approval.id}`} className="text-sm font-medium">
            Edit the exact request
          </label>
          <p className="mt-1 text-xs text-muted">
            This is the technical payload the assistant will use after approval.
          </p>
          <textarea
            id={`approval-payload-${approval.id}`}
            name="payload"
            rows={8}
            defaultValue={editState.raw ?? approval.payloadJson}
            spellCheck={false}
            className="mt-3 w-full rounded-xl border border-edge bg-raised p-3 font-mono text-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {editState.error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SubmitButton variant="primary" pendingLabel="Approving…">
              <Check aria-hidden="true" />
              Approve edited request
            </SubmitButton>
            <button
              type="button"
              disabled={editPending}
              onClick={() => setEditing(false)}
              className={btn.outline}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div
          className={`${cardFooterClass} max-sm:grid max-sm:grid-cols-1 @max-[21rem]/approval:px-3 @min-[21rem]/approval:max-sm:grid-cols-2`}
        >
          <form action={approveApproval.bind(null, approval.id)} className="min-w-0">
            <ConfirmButton
              variant="primary"
              pendingLabel="Approving…"
              confirmLabel="Approve?"
              className="w-full sm:w-auto"
            >
              <Check aria-hidden="true" />
              Approve
            </ConfirmButton>
          </form>
          <form action={denyApproval.bind(null, approval.id)} className="min-w-0">
            <ConfirmButton
              variant="outline"
              pendingLabel="Denying…"
              confirmLabel="Deny?"
              className="w-full sm:w-auto"
            >
              <X aria-hidden="true" />
              Deny
            </ConfirmButton>
          </form>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`${btn.outline} col-span-1 w-full @min-[21rem]/approval:col-span-2 sm:col-auto sm:w-auto`}
          >
            <PencilLine aria-hidden="true" />
            Edit request
          </button>
          {approval.rememberLabel ? (
            <form
              action={approveAndRemember.bind(null, approval.id)}
              className="col-span-1 @min-[21rem]/approval:col-span-2 sm:col-auto"
            >
              <AlwaysApproveButton scope={approval.rememberLabel} className="w-full sm:w-auto" />
            </form>
          ) : null}
        </div>
      )}
    </article>
  );
}
