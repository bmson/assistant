'use client';

import { useActionState, useEffect, useState } from 'react';
import { type OwnerCallGrantActionState, ownerCallNumberGrantAction } from './actions';

const initialState: OwnerCallGrantActionState = {
  error: null,
  preview: null,
  completed: false,
};

function expiryLabel(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    }).format(new Date(value));
  } catch {
    return `${new Date(value).toISOString()} (UTC)`;
  }
}

function detail(title: string, value: string | undefined, disclosure: string) {
  return (
    <div>
      <dt className="text-xs font-semibold text-strong">{title}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-sm leading-5 text-muted">
        {value?.trim() || disclosure}
      </dd>
    </div>
  );
}

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
  const [cancelledToken, setCancelledToken] = useState<string | null>(null);
  const [expiredToken, setExpiredToken] = useState<string | null>(null);
  useEffect(() => {
    if (!state.preview) return;
    const token = state.preview.reviewToken;
    const timer = setTimeout(
      () => setExpiredToken(token),
      Math.max(0, Date.parse(state.preview.reviewExpiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state.preview]);
  const preview =
    state.preview?.reviewToken === cancelledToken || state.preview?.reviewToken === expiredToken
      ? null
      : state.preview;
  const reviewError =
    state.error ??
    (state.preview?.reviewToken === expiredToken
      ? 'This review expired or changed. Review again.'
      : null);

  if (state.completed) {
    return (
      <p className="rounded-xl bg-accent/10 px-3 py-2.5 text-sm leading-5 text-strong">
        This call is approved, not yet completed. Future calls to the same number may use the
        reviewed permission until its expiry.
      </p>
    );
  }

  return (
    <section className="min-w-0 break-words rounded-2xl border border-edge bg-sunken/35 p-3 sm:p-4">
      <h4 className="text-sm font-semibold text-strong">Permission for future calls</h4>
      <p className="mt-1 text-xs leading-5 text-muted">
        This new permission is not created until you approve. This also approves the current call.
        It would let the assistant place future calls to the same number about any topic or script
        when you directly ask for a call, even if someone else answers. The assistant may share
        personal information from available context, including saved or retrieved information. We do
        not verify who controls this number or who answers.
      </p>

      <form action={action} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="mode" value="review" />
        <input type="hidden" name="action" value="preview_reusable_call_v1" />
        <label className="min-w-0 flex-1 text-xs font-medium text-muted">
          Permission duration
          <select
            name="validityChoice"
            defaultValue="7d"
            disabled={pending}
            onChange={() => setCancelledToken(preview?.reviewToken ?? null)}
            className="mt-1 block min-h-11 w-full rounded-xl border border-edge bg-raised px-3 text-sm text-strong outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-raised px-4 text-sm font-semibold text-strong ring-1 ring-inset ring-edge transition hover:bg-sunken disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? 'Preparing review…' : 'Review future permission'}
        </button>
      </form>

      {reviewError ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {reviewError}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-4 border-t border-edge pt-4">
          <h5 className="text-sm font-semibold text-strong">Review the exact permission</h5>
          <p className="mt-2 text-sm leading-6 text-strong">
            Simple requests such as “Call me now” or a call to this exact number may use this
            permission. Requests that add a topic, script, or other instructions require approval
            for that call. For “me”, “my phone”, or “my number”, your configured owner number must
            match this permission. A name alone still needs approval. Routing to this number does
            not verify who answers.
          </p>
          <p className="mt-2 text-sm leading-6 text-strong">
            Future permission covers {preview.grant.recipientE164}, any topic or script when you
            directly ask for a call, and anyone who answers. Future calls can use different topics,
            scripts and personal information from available context, including saved or retrieved
            information.
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            Future requests may ask for up to {preview.grant.maxMinutes} minutes per call. System
            maximum: {preview.configuredMaxMinutes} minutes. Existing rate and budget limits still
            apply; this permission adds no call quota.
          </p>
          {preview.existingActiveGrants.length > 0 ? (
            <div className="mt-3 text-sm leading-6">
              <p className="font-semibold">
                Other permissions remain active. This adds a permission; it does not replace or
                narrow them.
              </p>
              <ul className="mt-2 grid gap-2">
                {preview.existingActiveGrants.map((existing) => (
                  <li key={existing.policyId}>
                    {existing.match.recipientE164} · any topic or script when you directly ask for a
                    call · anyone may answer · requested duration ceiling{' '}
                    {existing.match.maxMinutes} minutes · expires{' '}
                    {expiryLabel(existing.match.expiresAt, preview.ownerTimeZone)} (
                    {preview.ownerTimeZone}). Personal information from available context, including
                    saved or retrieved information, may be shared.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <h6 className="mt-4 text-sm font-semibold text-strong">This call’s instructions</h6>
          <p className="mt-1 text-xs leading-5 text-muted">
            These are instructions to the voice assistant, not guarantees of what it will say or
            agree to. Future calls do not have to repeat this brief.
          </p>
          <dl className="mt-3 grid min-w-0 gap-3">
            {detail('Number future calls may reach', preview.grant.recipientE164, 'Not specified')}
            {detail('Who may answer', 'Anyone who answers the call', 'Not specified')}
            {detail(
              'Topics',
              'Any topic or script when you directly ask for a call',
              'Not specified',
            )}
            {detail('Language for this call', preview.brief.language, 'Not specified')}
            {detail('Goal for this call', preview.brief.goal, 'Not specified')}
            {detail('Contact label', preview.brief.contactName, 'Not specified')}
            {detail('Context the assistant may share', preview.brief.context, 'Not specified')}
            {detail('What it may agree to', preview.brief.mayAgreeTo, 'Not specified')}
            {detail('What it must not do', preview.brief.mustNot, 'Not specified')}
            {detail(
              'Requested call duration',
              `${preview.grant.maxMinutes} minutes`,
              'Not specified',
            )}
            {detail(
              'Configured system maximum',
              `${preview.configuredMaxMinutes} minutes`,
              'Not specified',
            )}
            {detail(
              'Voicemail behavior',
              preview.brief.onVoicemail === 'leave_message' ? 'Leave a message' : 'Hang up',
              'Not specified',
            )}
            {detail(
              preview.brief.onVoicemail === 'hang_up'
                ? 'Saved voicemail message (not used when hanging up)'
                : 'Voicemail message',
              preview.brief.voicemailMessage,
              'Not specified',
            )}
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted">
            The provider allows a 20-second introduction buffer beyond the configured maximum.
            Ending a call is asynchronous, so these timings do not guarantee a precise hang-up.
            Approval also does not mean the call has completed.
          </p>
          <p className="mt-2 text-xs font-medium text-strong">
            Permission expires {expiryLabel(preview.grant.expiresAt, preview.ownerTimeZone)} (
            {preview.ownerTimeZone}).
          </p>
          <p className="mt-1 text-xs text-muted">
            This review expires {expiryLabel(preview.reviewExpiresAt, preview.ownerTimeZone)}. If
            the call details change, review the permission again.
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">
            Expiry stops new authorizations. A call already in flight may continue. You can pause or
            delete the saved permission; re-enabling requires a fresh review from a pending owner
            call.
          </p>
          <form
            key={`${sourceFingerprint}:${preview.reviewToken}`}
            action={action}
            className="mt-4 rounded-xl border border-edge bg-raised p-3"
          >
            <input type="hidden" name="mode" value="approve" />
            <input type="hidden" name="action" value="approve_reusable_call_v1" />
            <input type="hidden" name="reviewToken" value={preview.reviewToken} />
            <input
              type="hidden"
              name="acknowledgement"
              value="any_direct_owner_topic_any_answerer_v1"
            />
            <label className="flex min-h-11 items-start gap-2 text-xs leading-5 text-muted">
              <input
                type="checkbox"
                name="confirmation"
                value="confirmed"
                required
                disabled={pending}
                className="mt-0.5 size-4 shrink-0 accent-accent"
              />
              <span>
                I understand this permits future calls to this number about any topic or script when
                you directly ask for a call, may disclose personal information from available
                context, including saved or retrieved information, and may be answered by anyone.
              </span>
            </label>
            <button
              type="submit"
              disabled={pending}
              className="mt-3 inline-flex min-h-12 w-full whitespace-normal items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:cursor-wait disabled:opacity-60"
            >
              {pending ? 'Saving permission…' : 'Approve this call and future permission'}
            </button>
          </form>
          <button
            type="button"
            disabled={pending}
            onClick={() => setCancelledToken(preview.reviewToken)}
            className="mt-2 min-h-11 w-full rounded-xl px-3 text-sm font-medium text-muted"
          >
            Cancel review
          </button>
        </div>
      ) : null}
    </section>
  );
}
