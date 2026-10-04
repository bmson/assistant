'use client';

import { useRef, useState } from 'react';
import { RecoveryCodeNotice } from '@/app/setup/recovery-code';
import {
  deviceLabel,
  ownerAuthMessage,
  registerPasskey,
  signInWithPasskey,
} from '@/lib/owner-auth/client';
import { btn, inputClass, labelClass, summaryClass } from '@/lib/ui';
import { ActionButton } from '@/lib/ui-client';

export function SignInClient() {
  const [pending, setPending] = useState<'signin' | 'recovery' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const recoveryInput = useRef<HTMLInputElement>(null);

  if (newRecoveryCode)
    return <RecoveryCodeNotice code={newRecoveryCode} continueHref="/security" />;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-xl bg-raised p-5 ring-1 ring-edge/70 sm:p-6">
        <p className="text-sm leading-6 text-muted">
          Unlock with Face ID, Touch ID, your screen lock, or a security key. Use a device where
          your passkey is available.
        </p>
        <div>
          <ActionButton
            variant="primary"
            pending={pending === 'signin'}
            pendingLabel="Waiting for passkey…"
            disabled={pending !== null}
            onClick={async () => {
              setPending('signin');
              setError(null);
              try {
                await signInWithPasskey();
                window.location.assign('/settings');
              } catch (failure) {
                setError(ownerAuthMessage(failure));
              } finally {
                setPending(null);
              }
            }}
          >
            Sign in with passkey
          </ActionButton>
        </div>
      </div>

      <details className="border-y border-edge/70 py-2">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is a native keyboard control; coordinate focus and block toggling during a request */}
        <summary
          className={summaryClass}
          aria-disabled={pending !== null}
          onClick={(event) => {
            if (pending !== null) {
              event.preventDefault();
              return;
            }
            const details = event.currentTarget.closest('details');
            if (details?.open) {
              setCode('');
              setError(null);
            } else {
              requestAnimationFrame(() => {
                if (details?.open) recoveryInput.current?.focus();
              });
            }
          }}
        >
          Lost your passkey?
        </summary>
        <form
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 pt-3 pb-4"
          aria-busy={pending === 'recovery'}
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending !== null) return;
            setPending('recovery');
            setError(null);
            try {
              const result = await registerPasskey('/api/owner/recovery', { code }, deviceLabel());
              setNewRecoveryCode(String(result.recoveryCode ?? ''));
            } catch (failure) {
              setError(ownerAuthMessage(failure));
            } finally {
              setPending(null);
            }
          }}
        >
          <label className={labelClass} htmlFor="recovery-code">
            Recovery code
          </label>
          <input
            ref={recoveryInput}
            id="recovery-code"
            className={`w-full ${inputClass} font-mono`}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="recovery-help"
            disabled={pending !== null}
            required
            minLength={25}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <p id="recovery-help" className="text-sm leading-6 text-muted">
            The recovery code adds a passkey on this device, replaces the code, and signs out every
            other browser. If you lost the code too, ask the person who manages this server for a
            recovery link.
          </p>
          <div>
            <button
              type="submit"
              className={`max-w-full ${btn.outline}`}
              disabled={pending !== null || code.trim().length < 25}
            >
              {pending === 'recovery' ? 'Waiting for passkey…' : 'Add passkey with recovery code'}
            </button>
          </div>
        </form>
      </details>

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
