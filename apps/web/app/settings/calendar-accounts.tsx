import { btn, Card, SectionHeading } from '@/lib/ui';
import { disconnectCalendarAccount } from './calendar-account-actions';

export function CalendarAccounts({
  ready,
  accounts,
  result,
}: {
  ready: boolean;
  accounts: Array<{ id: string; email: string; lastError: string | null }>;
  result?: string;
}) {
  return (
    <section className="grid gap-4">
      <SectionHeading title="Connected calendars" />
      <p className="max-w-[65ch] text-sm leading-6 text-muted">
        Connect a Google or work account to include its event details in your assistant’s calendar.
        Sign in with Google and complete your usual Okta or two-factor verification. Access is
        read-only and doesn’t include your email.
      </p>
      {result === 'connected' && (
        <p role="status" className="text-sm">
          Your calendar account is connected.
        </p>
      )}
      {(result === 'failed' || result === 'setup') && (
        <p role="alert" className="text-sm text-muted">
          The calendar couldn’t be connected. Try again and allow calendar access. If your work
          account blocks the connection, ask your IT team to approve this app.
        </p>
      )}
      {accounts.map((account) => (
        <Card key={account.id} className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 grid gap-1">
            <p className="break-all text-sm font-medium">{account.email}</p>
            <p className="text-sm text-muted">
              {account.lastError ?? 'Calendar connected · Read-only'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {account.lastError && ready && (
              <a href="/api/calendar-accounts/connect" className={btn.outline}>
                Reconnect
              </a>
            )}
            <form action={disconnectCalendarAccount}>
              <input type="hidden" name="id" value={account.id} />
              <button type="submit" className={btn.outline}>
                Disconnect
              </button>
            </form>
          </div>
        </Card>
      ))}
      {ready ? (
        <a href="/api/calendar-accounts/connect" className={`${btn.outline} justify-self-start`}>
          Add Google account
        </a>
      ) : (
        <p className="text-sm leading-6 text-muted">
          Calendar connections aren’t set up yet. Ask your assistant’s administrator to enable
          Google Calendar connections.
        </p>
      )}
      <p className="max-w-[65ch] text-xs leading-5 text-muted">
        Your workplace controls which apps can access calendar details and may require IT approval.
        Disconnecting removes this assistant’s saved access to the account.
      </p>
    </section>
  );
}
