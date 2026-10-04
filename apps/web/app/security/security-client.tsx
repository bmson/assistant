'use client';

import { Ellipsis } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RecoveryCodeNotice } from '@/app/setup/recovery-code';
import { CopyButton } from '@/lib/copy-button';
import { deviceLabel, ownerAuthMessage, ownerPost, registerPasskey } from '@/lib/owner-auth/client';
import {
  btn,
  iconButtonClass,
  inputClass,
  labelClass,
  MetaLine,
  SectionHeading,
  Skeleton,
} from '@/lib/ui';
import { ActionButton, ActionMenu, ConfirmButton } from '@/lib/ui-client';

type Passkey = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  backedUp: boolean;
};
type Device = { id: string; name: string; createdAt: string; revokedAt: string | null };

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal });
  if (response.status === 401) {
    window.location.assign('/signin');
    throw new Error('signed out');
  }
  if (!response.ok) throw new Error('request failed');
  return (await response.json()) as T;
}

function SecurityDate({ value }: { value: string }) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
    </time>
  );
}

export function SecurityClient({
  serverUrl,
  mode = 'all',
}: {
  serverUrl: string;
  mode?: 'all' | 'pairing';
}) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listStale, setListStale] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('iPhone');
  const deviceKeyHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const staleNotice = useRef<HTMLDivElement>(null);
  const running = useRef(false);
  useEffect(() => {
    if (deviceToken) deviceKeyHeading.current?.focus();
  }, [deviceToken]);
  useEffect(() => {
    if (error) errorNotice.current?.focus();
  }, [error]);
  useEffect(() => {
    if (listStale) staleNotice.current?.focus();
  }, [listStale]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [keys, phones] = await Promise.all([
        mode === 'pairing'
          ? Promise.resolve({ passkeys: [] as Passkey[] })
          : getJson<{ passkeys: Passkey[] }>('/api/owner/passkeys', signal),
        getJson<{ devices: Device[] }>('/api/owner/devices', signal),
      ]);
      setPasskeys(keys.passkeys);
      setDevices(phones.devices);
      setLoaded(true);
      setListStale(false);
    },
    [mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal)
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            mode === 'pairing'
              ? 'Could not load your devices. Check the connection and try again.'
              : 'Could not load your passkeys and devices. Check the connection and try again.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, mode]);

  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(ownerAuthMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  // A confirmed mutation and its subsequent projection read are separate
  // outcomes. Retrying a stale projection must never repeat the mutation.
  const refreshAfterChange = async (detail: string) => {
    setReceipt(detail);
    try {
      await refresh();
    } catch {
      setListStale(true);
    }
  };

  const retryRefresh = async () => {
    try {
      await refresh();
    } catch {
      setError(
        listStale
          ? 'The lists still could not refresh. Your confirmed change is saved. Check the connection and try Refresh lists again.'
          : mode === 'pairing'
            ? 'Could not load your devices. Check the connection and try again.'
            : 'Could not load your passkeys and devices. Check the connection and try again.',
      );
    }
  };

  const active = passkeys.filter((key) => !key.revokedAt);
  const activeDevices = devices.filter((device) => !device.revokedAt);
  const unavailable = busy || loading || !loaded || listStale;

  return (
    <div className="grid min-w-0 gap-8" aria-busy={busy || loading}>
      {receipt ? (
        <div className="grid min-w-0 gap-1 rounded-xl bg-sunken/50 p-4">
          <h2 className="text-sm font-semibold text-strong">Last confirmed change</h2>
          <p role="status" className="text-sm leading-6 text-strong break-words">
            {receipt}
          </p>
        </div>
      ) : null}
      {listStale ? (
        <div
          ref={staleNotice}
          tabIndex={-1}
          className="grid min-w-0 gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40"
        >
          <p role="alert" className="text-sm leading-6 text-amber-900 dark:text-amber-200">
            The change is saved, but the{' '}
            {mode === 'pairing' ? 'device list' : 'passkey and device lists'} could not refresh. The
            lists below are out of date. Refresh them before making another change.
          </p>
          <div>
            <ActionButton
              pending={busy}
              pendingLabel="Refreshing…"
              onClick={() => void run(retryRefresh)}
            >
              Refresh lists
            </ActionButton>
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          ref={errorNotice}
          tabIndex={-1}
          className="grid gap-3 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
        >
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
          {!loaded ? (
            <div>
              <ActionButton
                pending={busy}
                pendingLabel="Loading…"
                onClick={() => void run(retryRefresh)}
              >
                Try again
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="sr-only">
          {mode === 'pairing' ? 'Loading connected devices…' : 'Loading passkeys and devices…'}
        </p>
      ) : null}
      {mode === 'all' ? (
        <>
          <section className="grid min-w-0 gap-4 border-b border-edge/70 pb-8">
            <div className="grid gap-2">
              <SectionHeading title="Passkeys" count={loaded ? active.length : undefined} />
              <p className="max-w-[65ch] text-sm leading-6 text-muted">
                Keep a backup on another device or a hardware key. Removing a passkey signs out
                every browser; you must keep at least one.
              </p>
            </div>
            {loading ? <Skeleton className="h-16 w-full" /> : null}
            {loaded && active.length === 0 ? (
              <p className="text-sm text-muted">No active passkeys were found.</p>
            ) : null}
            <ul className={active.length ? 'divide-y divide-edge/70 border-y border-edge/70' : ''}>
              {active.map((key) => (
                <li key={key.id} className="flex min-w-0 items-start justify-between gap-3 py-4">
                  <div className="grid min-w-0 flex-1 gap-1">
                    <p className="text-sm font-medium text-strong break-words">{key.label}</p>
                    <MetaLine
                      segments={[
                        <>
                          Added <SecurityDate value={key.createdAt} />
                        </>,
                        key.backedUp ? 'Synced passkey' : null,
                        key.lastUsedAt ? (
                          <>
                            Last used <SecurityDate value={key.lastUsedAt} />
                          </>
                        ) : null,
                      ]}
                    />
                  </div>
                  <ActionMenu
                    label={
                      <>
                        <Ellipsis className="size-4" aria-hidden="true" />
                        <span className="sr-only">Passkey options for {key.label}</span>
                      </>
                    }
                    triggerClassName={iconButtonClass}
                    triggerTitle={`Passkey options for ${key.label}`}
                  >
                    <ConfirmButton
                      variant="menuDanger"
                      disabled={unavailable || active.length < 2}
                      confirmLabel="Remove passkey?"
                      title={
                        active.length < 2
                          ? 'Add another passkey before removing your last one.'
                          : `Remove ${key.label} and sign out every browser`
                      }
                      onConfirm={() =>
                        void run(async () => {
                          await ownerPost(
                            `/api/owner/passkeys?id=${encodeURIComponent(key.id)}`,
                            {},
                            'DELETE',
                          );
                          setReceipt(`Passkey “${key.label}” removed. Signing out every browser.`);
                          window.location.assign('/signin');
                        })
                      }
                    >
                      Remove passkey
                    </ConfirmButton>
                    {active.length < 2 ? (
                      <p className="px-3 py-2 text-xs leading-5 text-muted">
                        Add a backup passkey before removing your last one.
                      </p>
                    ) : (
                      <p className="px-3 py-2 text-xs leading-5 text-muted">
                        Removing it signs out every browser.
                      </p>
                    )}
                  </ActionMenu>
                </li>
              ))}
            </ul>
            <div>
              <button
                type="button"
                className={btn.outline}
                disabled={unavailable}
                onClick={() =>
                  run(async () => {
                    await registerPasskey('/api/owner/passkeys', {}, deviceLabel());
                    await refreshAfterChange(
                      'Passkey added on this device. You can use it to sign in.',
                    );
                  })
                }
              >
                Add a passkey
              </button>
            </div>
          </section>

          <section className="grid min-w-0 gap-4 border-b border-edge/70 pb-8">
            <div className="grid gap-2">
              <SectionHeading title="Recovery code" />
              <p className="max-w-[65ch] text-sm leading-6 text-muted">
                Your saved code lets you add a passkey if you lose your device. Replacing it
                invalidates the old code immediately. Save the replacement before leaving.
              </p>
            </div>
            {recoveryCode ? <RecoveryCodeNotice code={recoveryCode} /> : null}
            <div>
              <ConfirmButton
                variant="outline"
                disabled={unavailable}
                confirmLabel="Replace recovery code?"
                onConfirm={() =>
                  void run(async () => {
                    const result = await ownerPost('/api/owner/recovery-code', {});
                    setRecoveryCode(String(result.recoveryCode ?? ''));
                    setReceipt(
                      'Recovery code replaced. The old code no longer works. Save the new code below before leaving.',
                    );
                  })
                }
              >
                Replace recovery code
              </ConfirmButton>
            </div>
          </section>
        </>
      ) : null}
      <section
        className={`grid min-w-0 gap-4 ${mode === 'all' ? 'border-b border-edge/70 pb-8' : ''}`}
      >
        <div className="grid gap-2">
          <SectionHeading title="iPhone and other devices" />
          <p className="max-w-[65ch] text-sm leading-6 text-muted">
            Enter this server address and a device key in the app&apos;s Connection screen. Each
            device has its own key, so revoking one leaves the others connected.
          </p>
        </div>
        <div className="grid min-w-0 gap-2">
          <h3 className={labelClass}>Server address</h3>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <code className="flex min-h-11 min-w-0 items-center rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-sm break-all select-all">
              {serverUrl}
            </code>
            <CopyButton value={serverUrl} name="server address" />
          </div>
        </div>
        {deviceToken ? (
          <div className="grid gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <h3
              ref={deviceKeyHeading}
              tabIndex={-1}
              className="text-sm font-medium text-emerald-800 dark:text-emerald-300"
            >
              Device key — copy it now. It won&apos;t be shown again.
            </h3>
            <code className="font-mono text-sm break-all select-all">{deviceToken}</code>
            <CopyButton value={deviceToken} name="device key" />
          </div>
        ) : null}
        {loading ? <Skeleton className="h-16 w-full" /> : null}
        <div className="grid min-w-0 gap-2">
          <h3 className="text-sm font-semibold text-strong">Device keys</h3>
          {loaded && activeDevices.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              No device keys yet. Create one below, then enter it in the app.
            </p>
          ) : null}
          <ul
            className={
              activeDevices.length ? 'divide-y divide-edge/70 border-y border-edge/70' : ''
            }
          >
            {activeDevices.map((device) => (
              <li key={device.id} className="flex min-w-0 items-start justify-between gap-3 py-4">
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="text-sm font-medium text-strong break-words">{device.name}</p>
                  <MetaLine
                    segments={[
                      <>
                        Added <SecurityDate value={device.createdAt} />
                      </>,
                    ]}
                  />
                </div>
                <ActionMenu
                  label={
                    <>
                      <Ellipsis className="size-4" aria-hidden="true" />
                      <span className="sr-only">Device options for {device.name}</span>
                    </>
                  }
                  triggerClassName={iconButtonClass}
                  triggerTitle={`Device options for ${device.name}`}
                >
                  <ConfirmButton
                    variant="menuDanger"
                    disabled={unavailable}
                    confirmLabel="Revoke device key?"
                    title={`Disconnect ${device.name} from the assistant`}
                    onConfirm={() =>
                      void run(async () => {
                        await ownerPost(
                          `/api/owner/devices?id=${encodeURIComponent(device.id)}`,
                          {},
                          'DELETE',
                        );
                        await refreshAfterChange(
                          `Device key for “${device.name}” revoked. Other devices stay connected.`,
                        );
                      })
                    }
                  >
                    Revoke device key
                  </ConfirmButton>
                  <p className="px-3 py-2 text-xs leading-5 text-muted">
                    This device will lose access. Other devices stay connected.
                  </p>
                </ActionMenu>
              </li>
            ))}
          </ul>
        </div>
        <form
          className="grid min-w-0 gap-4 rounded-xl bg-sunken/50 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (unavailable) return;
            void run(async () => {
              const result = await ownerPost('/api/owner/devices', { name: deviceName });
              setDeviceToken(String(result.token ?? ''));
              await refreshAfterChange(
                `Device key created for “${deviceName}”. Copy the key below into that device’s Connection screen; it will not be shown again.`,
              );
            });
          }}
        >
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold text-strong">Connect another device</h3>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="grid min-w-0 gap-2">
              <span className={labelClass}>Device name</span>
              <input
                className={inputClass}
                value={deviceName}
                required
                disabled={unavailable}
                maxLength={80}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className={btn.primary}
              disabled={unavailable || !deviceName.trim()}
            >
              {busy ? 'Working…' : 'Create device key'}
            </button>
          </div>
        </form>
      </section>

      {mode === 'all' ? (
        <section className="grid gap-4">
          <div className="grid gap-2">
            <SectionHeading title="Browser sessions" />
            <p className="max-w-[65ch] text-sm leading-6 text-muted">
              Sign out of this browser and every other browser. Your passkeys and device keys stay
              active; you can sign in again with a passkey.
            </p>
          </div>
          <div>
            <ConfirmButton
              disabled={unavailable}
              confirmLabel="Sign out every browser?"
              onConfirm={() =>
                void run(async () => {
                  await ownerPost('/api/owner/logout', { everywhere: true });
                  window.location.assign('/signin');
                })
              }
            >
              Sign out everywhere
            </ConfirmButton>
          </div>
        </section>
      ) : null}
    </div>
  );
}
