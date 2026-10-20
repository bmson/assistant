import Link from 'next/link';
import { focusRing } from '@/lib/ui';
import type { AsyncNote, PollTrouble } from './use-chat-polling';

interface ChatTurnFeedbackProps {
  showError: boolean;
  error: string | null;
  note: AsyncNote | null;
  pollTrouble: PollTrouble;
  canRetry: boolean;
  onRetry: () => void;
}

/** Durable turn feedback belongs after the empty/populated transcript choice. */
export function ChatTurnFeedback({
  showError,
  error,
  note,
  pollTrouble,
  canRetry,
  onRetry,
}: ChatTurnFeedbackProps) {
  return (
    <>
      {showError ? (
        <p
          role="alert"
          data-chat-reading-block="true"
          className="chat-action-error mt-6 rounded-xl border px-4 py-3 text-sm leading-6"
        >
          {error}
        </p>
      ) : null}
      {note ? (
        <p data-chat-reading-block="true" role="status" className="mt-3 text-xs text-stage-muted">
          {note.text}{' '}
          <Link href="/tasks" className="font-medium underline underline-offset-2">
            Open Activity
          </Link>
          {note.retryable && canRetry ? (
            <>
              {' · '}
              <button
                type="button"
                onClick={onRetry}
                className={`font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
              >
                Try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {pollTrouble === 'expired' ? (
        <p data-chat-reading-block="true" role="alert" className="mt-3 text-xs text-stage-muted">
          Your session expired — live updates are off.{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={`font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
          >
            Reload to sign in again
          </button>
        </p>
      ) : pollTrouble === 'stale' ? (
        <p data-chat-reading-block="true" role="status" className="mt-3 text-xs text-stage-muted">
          Live updates paused — retrying.
        </p>
      ) : null}
    </>
  );
}
