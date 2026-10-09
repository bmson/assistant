import type { EmailObligationView } from '@assistant/application/email-obligations';
import { Check, Clock3, RotateCcw } from 'lucide-react';
import { decideEmailObligationAction } from '@/app/profile/actions';
import { cardShellClass } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

function stateLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'You confirmed this still needs attention';
    case 'resolved':
      return 'You marked this resolved';
    case 'snoozed':
      return 'You asked to revisit this later';
    default:
      return 'Needs your review';
  }
}

export function EmailObligationsPanel({ rows }: { rows: EmailObligationView[] }) {
  return (
    <section className={`${cardShellClass} mt-8`}>
      <div className="border-b border-edge px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold tracking-[-0.025em]">Email follow-ups</h2>
        <p className="mt-1 text-sm leading-5 text-muted">
          Classifier suggestions stay unconfirmed until you review the latest message in a thread.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted sm:px-6">
          No current email follow-ups to review.
        </p>
      ) : (
        <div className="divide-y divide-edge">
          {rows.map((row) => (
            <div key={row.channelMessageId} className="flex flex-col gap-3 px-5 py-4 sm:px-6">
              <div>
                <p className="text-xs text-muted">{stateLabel(row.obligationStatus)}</p>
                <p className="mt-1 text-sm font-medium text-strong">
                  {row.subject || '(no subject)'}
                </p>
                <p className="mt-1 text-xs text-muted">From {row.fromName || row.fromEmail}</p>
                <a
                  className="mt-1 inline-block text-xs text-accent underline-offset-4 hover:underline"
                  href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(row.providerThreadId ?? '')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open current thread in Gmail
                </a>
                <p className="mt-1 text-xs leading-5 text-muted">
                  This is a review of the current source. Resolving or snoozing here records your
                  decision; triage task status does not.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {row.obligationStatus === 'resolved' ? (
                  <form
                    action={decideEmailObligationAction.bind(
                      null,
                      row.channelMessageId,
                      row.obligationVersion,
                      'reopen',
                    )}
                  >
                    <SubmitButton pendingLabel="Reopening…">
                      <RotateCcw aria-hidden="true" /> Reopen
                    </SubmitButton>
                  </form>
                ) : (
                  <>
                    {row.obligationStatus !== 'open' ? (
                      <form
                        action={decideEmailObligationAction.bind(
                          null,
                          row.channelMessageId,
                          row.obligationVersion,
                          'confirm_open',
                        )}
                      >
                        <SubmitButton variant="primary" pendingLabel="Saving…">
                          <Check aria-hidden="true" /> I still owe something
                        </SubmitButton>
                      </form>
                    ) : null}
                    <form
                      action={decideEmailObligationAction.bind(
                        null,
                        row.channelMessageId,
                        row.obligationVersion,
                        'resolve',
                      )}
                    >
                      <SubmitButton variant="primary" pendingLabel="Saving…">
                        <Check aria-hidden="true" /> Resolved
                      </SubmitButton>
                    </form>
                    <form
                      action={decideEmailObligationAction.bind(
                        null,
                        row.channelMessageId,
                        row.obligationVersion,
                        'snooze',
                      )}
                    >
                      <SubmitButton pendingLabel="Saving…">
                        <Clock3 aria-hidden="true" /> Later
                      </SubmitButton>
                    </form>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
