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
          Enabled rules let the assistant repeat approved actions without asking each time. Pausing
          or removing a rule stops using that rule. Other saved rules may still allow the same
          action.
        </p>
      </div>
      {policies.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No standing approval rules are saved.</p>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {policies.map((policy) => {
            const isPhone = policy.toolName === 'phone.call';
            const needsPhoneReview =
              policy.phoneCallState === 'Paused' ||
              policy.phoneCallState === 'Expired' ||
              policy.phoneCallState === 'Unavailable' ||
              policy.phoneCallState === 'Saved scope unavailable';
            return (
              <li key={policy.id}>
                <Card className="grid min-w-0 gap-4">
                  {isPhone ? (
                    <div className="grid min-w-0 gap-2">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h3 className="min-w-0 font-medium text-strong">
                          Call · {policy.phoneCallRecipient ?? 'Saved scope unavailable'}
                        </h3>
                        <span className="text-xs text-muted">
                          {policy.phoneCallState ?? 'Saved scope unavailable'}
                        </span>
                      </div>
                      <p className="break-words text-sm leading-6 text-muted">
                        {policy.phoneCallLimitLine ?? 'Saved scope unavailable'}
                      </p>
                      {policy.phoneCallPresentation?.kind === 'same_brief' ? (
                        <PhoneCallPolicyDetails
                          presentation={policy.phoneCallPresentation}
                          savedLabel={policy.label}
                        />
                      ) : (
                        <details className="min-w-0 rounded-lg border border-edge px-3 py-2">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium text-strong">
                            Permission details
                          </summary>
                          <div className="mt-2 grid min-w-0 gap-2 text-sm leading-6 text-muted">
                            {policy.phonePermissionKind === 'owner_number' ? (
                              <>
                                <p className="break-words">{policy.scope}</p>
                                <p>
                                  This permission covers future direct requests to the saved number;
                                  it is broader than repeating one exact call brief.
                                </p>
                                <p>The saved number match does not verify who answers the call.</p>
                              </>
                            ) : (
                              <>
                                <p>Saved scope unavailable. This rule cannot be interpreted.</p>
                                {policy.opaqueDetails ||
                                policy.phoneCallPresentation?.kind === 'opaque' ? (
                                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                                    {policy.opaqueDetails ??
                                      (policy.phoneCallPresentation?.kind === 'opaque'
                                        ? policy.phoneCallPresentation.details
                                        : '')}
                                  </pre>
                                ) : null}
                              </>
                            )}
                          </div>
                        </details>
                      )}
                      {needsPhoneReview ? (
                        <p className="break-words text-sm leading-6 text-muted">
                          <a href="/approvals#waiting-for-you" className="underline">
                            Review a new permission
                          </a>{' '}
                          from a pending owner call. This saved rule stays unchanged.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="grid min-w-0 gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="min-w-0 font-medium text-strong">
                          {policy.label ?? policy.templateKey.replaceAll('.', ' ')}
                        </h3>
                        <span className="text-xs text-muted">
                          {policy.enabled ? 'Enabled' : 'Paused'}
                        </span>
                      </div>
                      <p className="break-words text-sm leading-6 text-muted">
                        {policy.scope ?? policy.toolName.replaceAll('.', ' ')}
                      </p>
                    </div>
                  )}
                  <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-edge/70 pt-3">
                    {!isPhone || policy.enabled ? (
                      <form action={setPolicyEnabled.bind(null, policy.id, !policy.enabled)}>
                        <SubmitButton size="sm" variant="outline">
                          {policy.enabled ? 'Pause rule' : 'Enable rule'}
                        </SubmitButton>
                      </form>
                    ) : null}
                    <form action={deletePolicy.bind(null, policy.id)}>
                      <ConfirmButton
                        size="sm"
                        className={isPhone ? 'min-h-11' : undefined}
                        confirmLabel={isPhone ? 'Remove permission?' : 'Delete rule?'}
                      >
                        {isPhone ? 'Remove permission' : 'Delete rule'}
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
