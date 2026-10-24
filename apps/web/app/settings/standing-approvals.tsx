import type { StandingApprovalPolicyView } from '@/lib/standing-approval-view';
import { Card, SectionHeading } from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';
import { deletePolicy, setPolicyEnabled } from './actions';
import { PhoneCallPolicyDetails } from './phone-call-policy-details';

export function StandingApprovals({ policies }: { policies: StandingApprovalPolicyView[] }) {
  return (
    <section className="grid gap-4 border-t border-edge/70 pt-8">
      <div className="grid gap-2">
        <SectionHeading title="Standing approvals" />
        <p className="max-w-[64ch] text-sm leading-6 text-muted">
          Enabled rules let the assistant repeat approved actions without asking each time. Pause a
          rule to require approval again, or remove it.
        </p>
      </div>
      {policies.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No standing approval rules are saved.</p>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {policies.map((policy) => {
            const restrictedPhone =
              policy.toolName === 'phone.call' &&
              policy.phoneCallPresentation?.kind !== 'same_brief';
            return (
              <li key={policy.id}>
                <Card className="grid min-w-0 gap-4">
                  <div className="grid min-w-0 gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="min-w-0 font-medium text-strong">
                        {policy.label ?? policy.templateKey.replaceAll('.', ' ')}
                      </h3>
                      <span className="text-xs text-muted">
                        {restrictedPhone
                          ? `Stored setting: ${policy.enabled ? 'On' : 'Off'}`
                          : policy.enabled
                            ? 'Enabled'
                            : 'Paused'}
                      </span>
                    </div>
                    {restrictedPhone ? (
                      <div className="grid min-w-0 gap-2 text-sm leading-6">
                        {policy.phonePermissionKind === 'owner_number' ? (
                          <p className="whitespace-pre-wrap break-words text-muted">
                            {policy.scope}
                          </p>
                        ) : (
                          <p className="text-muted">Saved phone-call scope (not interpreted)</p>
                        )}
                        <p className="break-words text-muted">
                          {policy.effectiveAvailability ??
                            'Availability unavailable. Refresh to check this saved permission.'}
                        </p>
                        {policy.opaqueDetails || policy.phoneCallPresentation?.kind === 'opaque' ? (
                          <details className="min-w-0 rounded-lg border border-edge px-3 py-2">
                            <summary className="flex min-h-11 cursor-pointer items-center font-medium text-strong">
                              Stored permission details
                            </summary>
                            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
                              {policy.opaqueDetails ??
                                (policy.phoneCallPresentation?.kind === 'opaque'
                                  ? policy.phoneCallPresentation.details
                                  : '')}
                            </pre>
                          </details>
                        ) : null}
                        {policy.phonePermissionKind === 'owner_number' && !policy.enabled ? (
                          <p className="break-words text-muted">
                            For a new future-call permission,{' '}
                            <a href="/approvals#waiting-for-you" className="underline">
                              review a new permission from a pending owner call
                            </a>
                            . This paused entry remains unchanged.
                          </p>
                        ) : null}
                      </div>
                    ) : policy.phoneCallPresentation?.kind === 'same_brief' ? (
                      <PhoneCallPolicyDetails presentation={policy.phoneCallPresentation} />
                    ) : policy.phoneCallPresentation?.kind === 'opaque' ? (
                      <div className="grid min-w-0 gap-2 text-sm">
                        <p className="text-muted">Saved phone-call scope (not interpreted)</p>
                        <details className="min-w-0 rounded-lg border border-edge px-3 py-2">
                          <summary className="cursor-pointer font-medium text-strong">
                            Show saved rule data
                          </summary>
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
                            {policy.phoneCallPresentation.details}
                          </pre>
                        </details>
                      </div>
                    ) : (
                      <p className="break-words text-sm leading-6 text-muted">
                        {policy.scope ?? policy.toolName.replaceAll('.', ' ')}
                      </p>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-edge/70 pt-3">
                    {!restrictedPhone || policy.enabled ? (
                      <form action={setPolicyEnabled.bind(null, policy.id, !policy.enabled)}>
                        <SubmitButton
                          size="sm"
                          variant="outline"
                          className={restrictedPhone ? 'min-h-11' : undefined}
                        >
                          {policy.enabled ? 'Pause rule' : 'Enable rule'}
                        </SubmitButton>
                      </form>
                    ) : null}
                    <form action={deletePolicy.bind(null, policy.id)}>
                      <ConfirmButton
                        size="sm"
                        className={restrictedPhone ? 'min-h-11' : undefined}
                        confirmLabel="Delete rule?"
                      >
                        Delete rule
                      </ConfirmButton>
                    </form>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
