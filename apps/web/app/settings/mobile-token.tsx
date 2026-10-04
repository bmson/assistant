'use client';

import { useEffect, useRef, useState } from 'react';
import { rotateMobileToken } from '@/app/settings/actions';
import { CopyButton } from '@/lib/copy-button';
import { labelClass, summaryClass } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

/**
 * Pairing panel for the iOS app.
 *
 * The stored token NEVER reaches the browser: the server sends only a masked
 * preview (`ab12cd…wxyz`). The full value is visible exactly once — in the
 * response of the rotate action, held in component state until the page
 * changes — mirroring how GitHub PATs and Cloud providers handle their
 * tokens. An owner who needs a working key rotates and copies the fresh one.
 *
 * Rotation persists to the local .env or to Secret Manager on Cloud Run.
 * Other Cloud Run instances refresh the secret within 30 seconds.
 */
export function MobileTokenPanel({
  maskedToken,
  serverUrl,
  canRotate,
}: {
  /** Masked preview like `ab12cd…wxyz`, or null when no token is configured. */
  maskedToken: string | null;
  serverUrl: string;
  canRotate: boolean;
}) {
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (freshToken) keyHeading.current?.focus();
  }, [freshToken]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Server address</span>
          <code className="min-w-0 rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-sm text-strong break-all select-all">
            {serverUrl}
          </code>
          <CopyButton value={serverUrl} name="server address" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Current key</span>
          <code className="min-w-0 truncate rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-sm text-strong select-all">
            {maskedToken ?? 'Not configured'}
          </code>
          <p className="text-xs leading-5 text-muted">
            Hidden for security. This preview cannot connect a device.
          </p>
        </div>
      </div>

      <p className="text-sm leading-6 text-muted">
        Enter the server address and a full access key in the mobile app’s Connection screen.
        {canRotate
          ? ' Create a new key below, then copy it into the app.'
          : maskedToken
            ? ' Use the full key you saved during setup, or ask the person who manages this server for a new one.'
            : ' Ask the person who manages this server to set up an access key.'}
      </p>

      {freshToken ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
          <h3
            ref={keyHeading}
            tabIndex={-1}
            className="text-sm font-medium text-emerald-800 dark:text-emerald-300"
          >
            New key — copy it now. It won’t be shown again.
          </h3>
          <code className="min-w-0 rounded-md border border-emerald-300 bg-white px-3 py-2 font-mono text-sm text-strong break-all select-all dark:border-emerald-800 dark:bg-emerald-950">
            {freshToken}
          </code>
          <CopyButton value={freshToken} name="access key" />
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            Update the Connection screen on your phone — the previous key stops working within 30
            seconds.
          </span>
        </div>
      ) : null}

      {canRotate ? (
        <div className="grid gap-2">
          {maskedToken ? (
            <p className="text-sm leading-6 text-muted">
              Creating a new key disconnects devices using the current key within 30 seconds. Update
              each device with the new key.
            </p>
          ) : null}
          <form
            action={async () => {
              setError(null);
              try {
                const result = await rotateMobileToken();
                if (result.error) {
                  setError(result.error);
                } else if (result.token) {
                  setFreshToken(result.token);
                }
              } catch {
                setError('Could not create a token. Check the server connection and try again.');
              }
            }}
          >
            <ConfirmButton
              variant={maskedToken ? 'dangerOutline' : 'primary'}
              pendingLabel={maskedToken ? 'Rotating…' : 'Generating…'}
              confirmLabel={maskedToken ? 'Confirm rotate' : 'Confirm generate'}
              title={
                maskedToken
                  ? 'Generate a new key and invalidate the current one'
                  : 'Generate a mobile access key'
              }
            >
              {maskedToken ? 'Create a replacement key' : 'Create access key'}
            </ConfirmButton>
          </form>
        </div>
      ) : (
        <details className="rounded-lg border border-edge p-3 text-sm">
          <summary className={summaryClass}>Server setup details</summary>
          <p className="mt-3 text-xs leading-5 text-muted">
            This server has neither a writable <code>.env</code> nor a <code>GCP_PROJECT</code>, so
            this page cannot save a replacement key. Set <code>MOBILE_API_TOKEN</code> in the server
            environment directly, then use that full value in the app.
          </p>
        </details>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
