'use client';

import { UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { btn, focusRing } from '@/lib/ui';
import { ActionMenu } from '@/lib/ui-client';
import { requestBrowserSignOut } from './browser-signout';
import { clearCardFormSessionStorage } from './chat/[id]/card-form-operations';

export function OwnerAccountMenu({ name }: { name: string }) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutThisBrowser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const destination = await requestBrowserSignOut();
      clearCardFormSessionStorage(window.sessionStorage);
      window.location.assign(destination);
    } catch {
      setSignOutError('Could not sign out. Try again.');
      setSigningOut(false);
    }
  };

  return (
    <ActionMenu
      trigger={
        <>
          <UserRound className="size-4" aria-hidden="true" />
          <span>Account</span>
        </>
      }
      triggerTitle="Owner account"
      triggerClassName={`${btn.outline} max-sm:px-2 gap-2 ${focusRing}`}
      panelClassName="w-64"
    >
      <div className="grid gap-3 p-3">
        <p className="truncate text-sm font-medium text-strong">{name}</p>
        <form action="/api/owner/browser-signout" method="post" onSubmit={signOutThisBrowser}>
          <button
            type="submit"
            disabled={signingOut}
            className={`${btn.outline} w-full disabled:opacity-60`}
          >
            {signingOut ? 'Signing out…' : 'Sign out of this browser'}
          </button>
        </form>
        {signOutError ? (
          <p role="alert" className="text-xs text-danger">
            {signOutError}
          </p>
        ) : null}
        <p className="text-xs leading-5 text-muted">
          Other browsers and your devices stay signed in.
        </p>
      </div>
    </ActionMenu>
  );
}
