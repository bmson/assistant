import type { PhoneCallPolicyPresentation } from '@assistant/application/approval-policy-presentation';

export function PhoneCallPolicyDetails({
  presentation,
  savedLabel,
}: {
  presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }>;
  savedLabel?: string | null;
}) {
  const voicemail =
    presentation.voicemailMode === 'leave_message' ? 'Leave a voicemail' : 'Hang up on voicemail';
  return (
    <details className="min-w-0 rounded-lg border border-edge px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-strong">
        Permission details
      </summary>
      <div className="mt-2 grid min-w-0 gap-2 text-sm leading-6">
        {savedLabel && savedLabel !== 'Repeat approved call' ? (
          <p className="break-words text-muted">Saved title: {savedLabel}</p>
        ) : null}
        <p className="break-words text-muted">
          This rule repeats one exact approved call brief. It does not authorize a different topic
          or script.
        </p>
        <p className="break-words text-muted">
          The saved number is the destination; a number match does not verify who answers.
        </p>
        <dl className="grid min-w-0 gap-2">
          {presentation.contactName ? (
            <PolicyCondition label="Saved recipient label" value={presentation.contactName} />
          ) : null}
          <PolicyCondition label="Recipient" value={presentation.recipient} />
          <PolicyCondition label="Goal" value={presentation.goal} />
          <PolicyCondition label="Maximum duration" value={`${presentation.maxMinutes} minutes`} />
          <PolicyCondition
            label="Context from the approved brief"
            value={presentation.mayShare || 'Not specified'}
          />
          <PolicyCondition
            label="May agree to"
            value={presentation.mayAgreeTo || 'Not specified'}
          />
          <PolicyCondition
            label="Instructions in approved brief"
            value={presentation.mustNot || 'Not specified'}
          />
          <PolicyCondition label="Language" value={presentation.language || 'Not specified'} />
          <PolicyCondition label="Voicemail" value={voicemail} />
          {presentation.voicemailMode === 'leave_message' ? (
            <PolicyCondition
              label="Exact voicemail message"
              value={presentation.voicemailMessage || 'Not specified'}
            />
          ) : presentation.voicemailMessage ? (
            <PolicyCondition
              label="Saved voicemail message (not used when hanging up)"
              value={presentation.voicemailMessage}
            />
          ) : null}
        </dl>
      </div>
    </details>
  );
}

function PolicyCondition({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-strong">{value}</dd>
    </div>
  );
}
