import { listApprovalInbox } from '@assistant/application/approvals';
import { getApprovalPolicySettings } from '@assistant/application/settings';
import { loadConfig } from '@assistant/config';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import {
  phonePermissionAvailability,
  phonePermissionKind,
  phonePermissionLabel,
  phonePermissionOpaqueDetails,
  policyScope,
} from '@/app/settings/labels';
import { requireOwner } from '@/auth';
import { getApprovalPolicyStore, getApprovalStore } from '@/lib/approval-store';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getAgentTimezone } from '@/lib/server';
import { EmptyState, MetaLine, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { StatusChip, taskTypeLabel, toPendingApprovalView } from '@/lib/views';
import { deleteSavedCallPermission, pauseSavedCallPermission } from './actions';
import { ApprovalCard } from './approval-card';
import { OwnerCallPermissionOperationRecovery } from './owner-call-number-grant';

export const metadata = { title: 'Approvals' };

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  await requireOwner();
  const now = new Date();
  const ownerNumberGrantEnabled = loadConfig().PHONE_CALL_TO_OWNER_GRANT_ENABLED;
  const [tz, { pending, resolved }, savedPolicies] = await Promise.all([
    getAgentTimezone(),
    listApprovalInbox(getApprovalStore()),
    getApprovalPolicySettings(getApprovalPolicyStore()),
  ]);

  return (
    <PageShell size="reading">
      <AutoRefresh />
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Approvals"
        intro="Review and approve or reject actions the assistant wants to take on your behalf."
      />

      <section id="waiting-for-you" className="mt-8">
        <SectionHeading title="Waiting for you" count={pending.length} />
        <p className="mt-1 text-sm leading-5 text-muted">
          Each card shows the real-world effect first. Policy and raw payload details stay available
          when you need them.
        </p>
        {pending.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />}>
            Nothing is waiting on you. The assistant asks here before anything leaves its workspace.
          </EmptyState>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            {pending.map(
              ({
                approval,
                taskType,
                taskTrust,
                toolName,
                decision,
                ownerCallSourceFingerprint,
                ownerCallAdmissionAvailable,
              }) => (
                <ApprovalCard
                  key={approval.id}
                  approval={toPendingApprovalView(
                    approval,
                    { type: taskType, trust: taskTrust },
                    { toolName, decision },
                    now,
                    tz,
                    ownerNumberGrantEnabled,
                    ownerCallSourceFingerprint,
                    ownerCallAdmissionAvailable,
                  )}
                />
              ),
            )}
          </div>
        )}
      </section>

      <section className="mt-8 min-w-0">
        <SectionHeading title="Saved phone permissions" />
        <p className="mt-1 text-sm leading-6 text-muted">
          Each permission applies independently. Adding one never replaces or narrows another. Pause
          or delete each permission separately.
        </p>
        <div className="mt-4 grid min-w-0 gap-3">
          {savedPolicies
            .filter((policy) => policy.toolName === 'phone.call')
            .map((policy) => (
              <div
                key={policy.id}
                className="min-w-0 break-words rounded-2xl border border-edge p-4"
              >
                <p className="text-sm font-semibold">
                  {phonePermissionLabel(policy.templateKey, policy.match)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">
                  {policyScope(policy.templateKey, policy.match) ??
                    'Stored permission details are unavailable.'}
                </p>
                <p className="mt-2 text-xs font-medium">
                  Stored setting: {policy.enabled ? 'On' : 'Off'}
                </p>
                {phonePermissionOpaqueDetails(policy.templateKey, policy.match) ? (
                  <details className="mt-2 min-w-0">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm">
                      Stored permission details
                    </summary>
                    <pre className="whitespace-pre-wrap break-all text-xs leading-5">
                      {phonePermissionOpaqueDetails(policy.templateKey, policy.match)}
                    </pre>
                  </details>
                ) : null}
                <p className="mt-2 text-xs font-medium">
                  {phonePermissionAvailability(policy, ownerNumberGrantEnabled, now) ??
                    (policy.enabled ? 'Stored setting: On' : 'Stored setting: Off')}
                </p>
                {phonePermissionKind(policy.templateKey, policy.match) === 'owner_number' &&
                !policy.enabled ? (
                  <p className="mt-2 text-sm leading-6 text-muted">
                    For a new future-call permission,{' '}
                    <a href="#waiting-for-you" className="underline">
                      review a new permission from a pending owner call
                    </a>
                    . This paused entry remains unchanged.
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {policy.enabled ? (
                    <form action={pauseSavedCallPermission.bind(null, policy.id)}>
                      <button
                        type="submit"
                        className="min-h-11 rounded-xl border border-edge px-3 text-sm font-medium"
                      >
                        Pause this permission
                      </button>
                    </form>
                  ) : null}
                  <details className="min-w-0 rounded-xl border border-edge px-3 text-sm">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                      Delete this permission…
                    </summary>
                    <p className="max-w-[60ch] py-2 leading-6 text-muted">
                      Delete this saved permission? Other permissions remain unchanged. A call
                      already in flight may continue.
                    </p>
                    <form action={deleteSavedCallPermission.bind(null, policy.id)}>
                      <button
                        type="submit"
                        className="mb-3 min-h-11 rounded-xl border border-edge px-3 font-semibold"
                      >
                        Confirm delete
                      </button>
                    </form>
                  </details>
                </div>
              </div>
            ))}
          {savedPolicies.every((policy) => policy.toolName !== 'phone.call') ? (
            <p className="text-sm text-muted">No saved phone permissions.</p>
          ) : null}
        </div>
      </section>

      <details className="group mt-6 rounded-2xl bg-sunken/55 p-5">
        <summary className="disclosure flex cursor-pointer items-center gap-2 text-base font-semibold">
          Recently resolved
          <span className="ml-auto text-xs font-normal text-muted group-open:hidden">
            {resolved.length} recent
          </span>
        </summary>
        {resolved.length === 0 ? (
          <EmptyState>No resolved approvals yet.</EmptyState>
        ) : (
          <div className="mt-4 divide-y divide-edge">
            {resolved.map(({ approval, taskType, toolName }) => {
              const displayStatus =
                approval.status === 'pending' && approval.expiresAt <= now
                  ? 'expired'
                  : approval.status;
              return (
                <div key={approval.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-5">{approval.summary}</p>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">
                        {approval.shortCode}
                      </span>
                      <StatusChip status={displayStatus} />
                    </span>
                  </div>
                  {/* A settled approval is a receipt — one line, not a grid. */}
                  <MetaLine
                    className="mt-1"
                    segments={[
                      <Link
                        key="task"
                        href={`/tasks/${approval.taskId}`}
                        className="hover:text-strong hover:underline"
                      >
                        {taskTypeLabel(taskType)}
                      </Link>,
                      `requested ${formatDateTime(approval.requestedAt, tz)}`,
                      approval.resolvedAt
                        ? `resolved ${relativeTime(approval.resolvedAt, now)}${approval.resolvedVia ? ` via ${approval.resolvedVia}` : ''}${approval.edited ? ' · edited' : ''}`
                        : `expired ${relativeTime(approval.expiresAt, now)}`,
                    ]}
                  />
                  {toolName === 'phone.call' ? (
                    <OwnerCallPermissionOperationRecovery
                      key={approval.id}
                      approvalId={approval.id}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </details>
    </PageShell>
  );
}
