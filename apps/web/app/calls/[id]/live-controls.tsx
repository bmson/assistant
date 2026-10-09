'use client';

import { LoaderCircle, PhoneOff, Send } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { answerCheckinAction, hangUpAction } from '@/app/calls/actions';
import { btn, inputClass } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

type Checkin = { id: string; question: string; revision: number };

function CheckinAnswer({
  callId,
  checkin,
  onSent,
}: {
  callId: string;
  checkin: Checkin;
  onSent: (id: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saving = useRef(false);
  return (
    <form
      className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (saving.current || !answer.trim()) return;
        saving.current = true;
        setError(null);
        const submitted = answer;
        startTransition(async () => {
          try {
            const result = await answerCheckinAction({
              callId,
              checkinId: checkin.id,
              revision: checkin.revision,
              answer: submitted,
            });
            if (result.error) setError(result.error);
            else onSent(checkin.id);
          } catch {
            setError('That did not go through. Your answer is kept here.');
          } finally {
            saving.current = false;
          }
        });
      }}
    >
      <p className="text-sm font-medium text-strong">The assistant is asking you</p>
      <p className="mt-1 text-base leading-6 text-strong">“{checkin.question}”</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          required
          disabled={pending}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          aria-label="Your answer"
          placeholder="Your answer, e.g. “Yes, 7:30 is fine”"
          className={`${inputClass} min-w-0 flex-1 basis-60`}
          maxLength={1_000}
        />
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
          ) : (
            <Send className="size-4" />
          )}{' '}
          Send
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        The other person is on hold. After about a minute the assistant tells them it will confirm
        later.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function CallControls({ callId, checkin }: { callId: string; checkin: Checkin | null }) {
  const [receipts, setReceipts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ending, startEnding] = useTransition();
  const hangingUp = useRef(false);
  return (
    <div className="flex flex-col gap-4">
      {checkin && !receipts.includes(checkin.id) ? (
        <CheckinAnswer
          key={checkin.id}
          callId={callId}
          checkin={checkin}
          onSent={(id) =>
            setReceipts((current) => (current.includes(id) ? current : [...current, id]))
          }
        />
      ) : null}
      {receipts.map((id) => (
        <p key={id} role="status" className="text-sm text-muted">
          Sent — the assistant has your answer.
        </p>
      ))}
      <div>
        <ConfirmButton
          disabled={ending}
          confirmLabel="Confirm hang up"
          title="End this call now"
          onConfirm={() => {
            if (hangingUp.current) return;
            hangingUp.current = true;
            setError(null);
            startEnding(async () => {
              try {
                const result = await hangUpAction(callId);
                if (result.error) setError(result.error);
              } catch {
                setError('The hang-up request did not go through. Try again.');
              } finally {
                hangingUp.current = false;
              }
            });
          }}
        >
          <PhoneOff className="size-4" /> Hang up
        </ConfirmButton>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Each check-in has its own draft and receipt; hanging up is independent of saving an answer. */
export function LiveCallControls({ callId, checkin }: { callId: string; checkin: Checkin | null }) {
  return <CallControls key={callId} callId={callId} checkin={checkin} />;
}
