import type { PhoneCallPolicyPresentation } from '@/lib/phone-call-policy-presentation';

export function PhoneCallPolicyDetails({
  presentation,
}: {
  presentation: Extract<PhoneCallPolicyPresentation, { kind: 'same_brief' }>;
}) {
  const voicemail =
    presentation.voicemailMode === 'leave_message' ? 'Leave a voicemail' : 'Hang up on voicemail';
  return (
    <div className="grid min-w-0 gap-3 text-sm leading-6">
      <p className="break-words text-strong">
        {presentation.contactName ? `${presentation.contactName} · ` : ''}
        {presentation.recipient} · up to {presentation.maxMinutes} min · Exact approved brief
      </p>
      <div className="grid min-w-0 gap-1.5 text-muted">
        <p className="break-words">
          {presentation.mayShare ? 'Context from the approved brief' : 'Context: Not specified'}
        </p>
        <p className="break-words">May agree to: {presentation.mayAgreeTo || 'Not specified'}</p>
        <p className="break-words">
          Instructions in approved brief: {presentation.mustNot || 'Not specified'}
        </p>
        <p className="break-words">
          Voicemail: {voicemail}
          {presentation.voicemailMode === 'leave_message' && !presentation.voicemailMessage
            ? ' · exact message: Not specified'
            : ''}
        </p>
      </div>
      <details className="min-w-0 rounded-lg border border-edge px-3 py-2">
        <summary className="cursor-pointer font-medium text-strong">Exact call brief</summary>
        <dl className="mt-2 grid min-w-0 gap-2 text-sm">
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
          ) : null}
          {presentation.voicemailMode === 'hang_up' && presentation.voicemailMessage ? (
            <PolicyCondition
              label="Saved voicemail message (not used when hanging up)"
              value={presentation.voicemailMessage}
            />
          ) : null}
        </dl>
      </details>
    </div>
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
