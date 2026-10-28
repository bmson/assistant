'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
import { type OwnerCallGrantActionState, ownerCallNumberGrantAction } from './actions';

const initialState: OwnerCallGrantActionState = { error: null, preview: null, completed: false };
function expiryLabel(value: string, timeZone: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(value)) + ` (${timeZone})`
    );
  } catch {
    return value + ' (UTC)';
  }
}
const money = (micros: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(micros / 1_000_000);
const button =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-edge bg-raised px-3 py-2 text-sm font-medium text-strong disabled:opacity-60';
const field =
  'mt-1 min-h-11 w-full min-w-0 rounded-xl border border-edge bg-raised px-3 text-sm text-strong';

/** The server slot is the durable barrier; remount always discovers it before a new review. */
export function OwnerCallNumberGrant({
  approvalId,
  sourceFingerprint,
}: {
  approvalId: string;
  sourceFingerprint: string;
}) {
  const [state, action, pending] = useActionState(
    ownerCallNumberGrantAction.bind(null, approvalId),
    initialState,
  );
  const [expiredToken, setExpiredToken] = useState<string | null>(null);
  useEffect(() => {
    if (!approvalId || !sourceFingerprint) return;
    const data = new FormData();
    data.set('mode', 'check');
    data.set('action', 'check_reusable_call_v2');
    startTransition(() => action(data));
  }, [approvalId, sourceFingerprint, action]);
  useEffect(() => {
    if (!state.preview) return;
    const { reviewToken, reviewExpiresAt } = state.preview;
    const timer = setTimeout(
      () => setExpiredToken(reviewToken),
      Math.max(0, Date.parse(reviewExpiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state.preview]);
  const preview = state.preview?.reviewToken === expiredToken ? null : state.preview;
  const operation = state.operation;
  const canReview =
    !!operation?.ok &&
    ['none', 'closed_no_effect', 'rejected_no_effect'].includes(operation.status);
  const unresolved =
    operation?.ok && (operation.status === 'registered' || operation.status === 'admitted');
  if (state.completed)
    return (
      <p className="text-sm text-strong">
        This call is approved, not completed. The reviewed future permission was saved.
      </p>
    );
  return (
    <section className="min-w-0 break-words rounded-2xl border border-edge bg-sunken/35 p-3 sm:p-4">
      <h4 className="text-sm font-semibold text-strong">Permission for future calls</h4>
      <p className="mt-1 text-xs leading-5 text-muted">
        Approve only this call with the ordinary approval controls, or review a separate permission
        for future calls to one canonical number. Existing permissions keep their scope.
      </p>
      <form action={action} className="mt-3">
        <input type="hidden" name="mode" value="check" />
        <input type="hidden" name="action" value="check_reusable_call_v2" />
        <button type="submit" className={button} disabled={pending}>
          {pending ? 'Checking…' : 'Check permission operation'}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {operation?.ok && operation.status === 'committed' ? (
        <p className="mt-2 text-sm">
          This operation saved a permission. Its current availability has not been checked here;
          review it in Settings. Approval does not mean the call completed.
        </p>
      ) : null}
      {operation?.ok &&
      (operation.status === 'closed_no_effect' || operation.status === 'rejected_no_effect') ? (
        <p className="mt-2 text-sm">
          This permission operation had no effect. It did not cancel or deny the call, or change
          other permissions.
        </p>
      ) : null}
      {unresolved ? (
        <div className="mt-3 space-y-2 text-sm">
          <p>
            {operation.status === 'registered'
              ? 'A review is registered. It has not been confirmed as saved.'
              : 'A save may still be in progress. A pending result does not prove it failed.'}{' '}
            Check the same operation; do not submit another save.
          </p>
          {operation.closeToken ? (
            <form action={action} className="space-y-2">
              <input type="hidden" name="mode" value="close" />
              <input type="hidden" name="action" value="close_reusable_call_v2" />
              <input type="hidden" name="closeToken" value={operation.closeToken} />
              <label className="flex min-h-11 items-start gap-2">
                <input
                  className="mt-1"
                  type="checkbox"
                  name="confirmation"
                  value="confirmed"
                  required
                  disabled={pending}
                />
                <span>
                  Close only this permission operation. If it already saved, that result wins. This
                  does not stop a call.
                </span>
              </label>
              <button type="submit" className={button} disabled={pending}>
                Close permission review
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <form action={action} className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <input type="hidden" name="mode" value="review" />
        <input type="hidden" name="action" value="preview_reusable_call_v2" />
        <label className="text-xs text-muted">
          Permission duration
          <select
            name="validityChoice"
            defaultValue="7d"
            className={field}
            disabled={pending || !canReview}
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          Calls in any 60 minutes
          <input
            name="callsPerHour"
            type="number"
            min="1"
            max="100"
            defaultValue="1"
            required
            className={field}
            disabled={pending || !canReview}
          />
        </label>
        <label className="text-xs text-muted">
          Calls in any 24 hours
          <input
            name="callsPerDay"
            type="number"
            min="1"
            max="100"
            defaultValue="3"
            required
            className={field}
            disabled={pending || !canReview}
          />
        </label>
        <label className="text-xs text-muted">
          Maximum USD per future call
          <input
            name="usdPerCall"
            type="number"
            min="0.01"
            step="0.01"
            defaultValue="1.00"
            required
            className={field}
            disabled={pending || !canReview}
          />
        </label>
        <label className="text-xs text-muted">
          Maximum USD in any 24 hours
          <input
            name="usdPerDay"
            type="number"
            min="0.01"
            step="0.01"
            defaultValue="3.00"
            required
            className={field}
            disabled={pending || !canReview}
          />
        </label>
        <button type="submit" className={button} disabled={pending || !canReview}>
          Review a new permission
        </button>
      </form>
      {preview ? (
        <div className="mt-4 space-y-3 border-t border-edge pt-4">
          <h5 className="text-sm font-semibold">Call {preview.grant.recipientE164}</h5>
          <p className="text-sm leading-6">
            Future direct owner requests to this number, up to {preview.grant.maxMinutes} minutes;{' '}
            {preview.grant.maxCallsPerHour} calls in 60 minutes and {preview.grant.maxCallsPerDay}{' '}
            in 24 hours; {money(preview.grant.maxCostUsdMicrosPerCall)} per call and{' '}
            {money(preview.grant.maxCostUsdMicrosPerDay)} in 24 hours. Expires{' '}
            {expiryLabel(preview.grant.expiresAt, preview.ownerTimeZone)}.
          </p>
          <p className="text-sm leading-6">
            Only eligible direct requests from you to call this number, within these limits, can use
            this permission. Future eligible calls may cover different topics or use different
            scripts and may share personal information from available context. Anyone may answer.
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
              Permission details
            </summary>
            <p className="text-sm leading-6">
              This number is a canonical destination match, not a verified person or answerer.
              Quoted, conditional, withdrawn, ambiguous or ordered requests do not gain automatic
              authority. A name alone still needs approval.
            </p>
            <dl className="mt-3 grid gap-3">
              {[
                ['Goal', preview.brief.goal],
                ['Contact label', preview.brief.contactName],
                ['Context that may be shared', preview.brief.context],
                ['May agree to', preview.brief.mayAgreeTo],
                ['Must not', preview.brief.mustNot],
                ['Language', preview.brief.language],
                [
                  'Voicemail behavior',
                  preview.brief.onVoicemail === 'leave_message' ? 'Leave a message' : 'Hang up',
                ],
                [
                  preview.brief.onVoicemail === 'leave_message'
                    ? 'Saved voicemail message'
                    : 'Saved voicemail message (not used when hanging up)',
                  preview.brief.voicemailMessage,
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-semibold">{label}</dt>
                  <dd className="whitespace-pre-wrap text-sm text-muted">
                    {value?.trim() || 'Not specified'}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs leading-5 text-muted">
              Limits apply to future permission reuse, not the separately approved current call.
              Estimated worst-case cost is reserved conservatively; failed or unknown calls may
              still consume the permission allowance. Global budgets and rate limits also apply.
              Expiry, pause and removal stop new authorization; they do not guarantee a call already
              in progress stops. Requested duration is not a precise hang-up guarantee.
            </p>
            {preview.existingActiveGrants.length ? (
              <p className="mt-2 text-sm">
                Other permissions remain active and unchanged. Review their separate limits in
                Settings; this new permission does not narrow or replace them.
              </p>
            ) : null}
          </details>
          <form
            key={`${sourceFingerprint}:${preview.reviewToken}`}
            action={action}
            className="space-y-3"
          >
            <input type="hidden" name="mode" value="approve" />
            <input type="hidden" name="action" value="approve_reusable_call_v2" />
            <input type="hidden" name="reviewToken" value={preview.reviewToken} />
            <input
              type="hidden"
              name="acknowledgement"
              value="owner_call_action_and_limits_any_answerer_v2"
            />
            <label className="flex min-h-11 items-start gap-2 text-xs leading-5">
              <input
                className="mt-1"
                type="checkbox"
                name="confirmation"
                value="confirmed"
                required
                disabled={pending}
              />
              <span>
                I approve this call and the future-call scope, sharing warning and limits shown
                above. Anyone may answer.
              </span>
            </label>
            <button type="submit" className={`${button} w-full`} disabled={pending}>
              Approve this call and save future permission
            </button>
          </form>
          <p className="text-xs text-muted">
            To change or discard this registered review, check its operation and explicitly close it
            first. No second save is sent automatically.
          </p>
        </div>
      ) : null}
      {state.preview?.reviewToken === expiredToken ? (
        <p className="mt-2 text-sm">
          The review expired. Check its operation; expiry alone does not prove a save failed.
        </p>
      ) : null}
    </section>
  );
}

/** Manual history recovery returns no tool payload and cannot create a permission. */
export function OwnerCallPermissionOperationRecovery({ approvalId }: { approvalId: string }) {
  const [state, action, pending] = useActionState(
    ownerCallNumberGrantAction.bind(null, approvalId),
    initialState,
  );
  const operation = state.operation;
  return (
    <div className="mt-3 space-y-2 text-sm">
      <form action={action}>
        <input type="hidden" name="mode" value="check" />
        <input type="hidden" name="action" value="check_reusable_call_v2" />
        <button type="submit" className={button} disabled={pending}>
          Check future-permission result
        </button>
      </form>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {operation?.ok ? (
        <p>
          {operation.status === 'committed'
            ? 'This operation saved a permission. Its current availability is unchecked; review Settings.'
            : operation.status === 'closed_no_effect' || operation.status === 'rejected_no_effect'
              ? 'This permission operation had no effect; it did not cancel the call or change other permissions.'
              : 'A saved permission has not been confirmed. Missing or pending data does not prove it failed.'}
        </p>
      ) : null}
      {operation?.ok && operation.status !== 'none' && operation.closeToken ? (
        <form action={action} className="space-y-2">
          <input type="hidden" name="mode" value="close" />
          <input type="hidden" name="action" value="close_reusable_call_v2" />
          <input type="hidden" name="closeToken" value={operation.closeToken} />
          <label className="flex min-h-11 items-start gap-2">
            <input
              type="checkbox"
              name="confirmation"
              value="confirmed"
              required
              disabled={pending}
            />
            <span>
              Close this permission operation only. A saved outcome wins; this does not stop the
              call.
            </span>
          </label>
          <button type="submit" className={button} disabled={pending}>
            Close permission review
          </button>
        </form>
      ) : null}
    </div>
  );
}
