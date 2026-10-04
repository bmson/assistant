'use client';

import { useEffect, useState } from 'react';
import { deviceLabel, ownerAuthMessage, registerPasskey } from '@/lib/owner-auth/client';
import { SectionHeading } from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';
import { RecoveryCodeNotice } from './recovery-code';

/**
 * The installer prints `/setup#claim=CODE`. The fragment never reaches the
 * server or its logs; it is read here and removed from the address bar and
 * history before anything else happens.
 */
export function SetupClient() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    const match = /(?:^|[#&])claim=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    setCode(match?.[1] ?? '');
  }, []);

  if (recoveryCode) return <RecoveryCodeNotice code={recoveryCode} continueHref="/settings" />;

  if (code === '')
    return (
      <section className="grid gap-3 rounded-xl bg-sunken/60 p-5">
        <SectionHeading title="Open your setup link" />
        <p className="text-sm leading-6 text-muted">
          Use the link printed by the installer. It contains a one-time claim code, valid for 24
          hours. If the link expired, run the installer&apos;s owner-claim step again to get a new
          one.
        </p>
      </section>
    );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-xl bg-raised p-5 ring-1 ring-edge/70 sm:p-6">
        <div className="grid gap-2">
          <SectionHeading title="Create your owner passkey" />
          <p className="text-sm leading-6 text-muted">
            This device will use Face ID, Touch ID, its screen lock, or a security key to sign you
            in. You do not need to create a password.
          </p>
        </div>
        <div>
          <ActionButton
            variant="primary"
            pending={busy}
            pendingLabel="Waiting for passkey…"
            disabled={code === null}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await registerPasskey(
                  '/api/owner/claim',
                  { code: code ?? '' },
                  deviceLabel(),
                );
                setRecoveryCode(String(result.recoveryCode ?? ''));
              } catch (failure) {
                setError(ownerAuthMessage(failure));
              } finally {
                setBusy(false);
              }
            }}
          >
            Create passkey
          </ActionButton>
        </div>
        <p className="border-t border-edge/70 pt-4 text-sm leading-6 text-muted">
          Next, save your recovery code. Then connect the mobile app in Settings.
        </p>
      </section>
      {code === null ? (
        <p role="status" className="sr-only">
          Checking your setup link…
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
